import { createHash, randomUUID } from 'node:crypto';
import { killed, transaction } from '../worker/control.js';
import { canonical } from './ledger.js';

export const QUEST_LIMITS = Object.freeze({ calls_per_person_day: 3, output_tokens: 256, person_day_micros: 100_000 });
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const demand = (value, message) => { if (!value) throw Error(message); };
const seal = row => { const { seal: _seal, ...body } = row; return digest(canonical(body)); };

// Quest is deliberately separate from a build run, but uses the same policy and
// accounting currency.  It has no unmetered provider seam.
export class QuestGateway {
  constructor(ledger, provider, { clock = Date.now } = {}) {
    demand(typeof provider === 'function', 'Quest provider required');
    this.ledger = ledger; this.store = ledger.store; this.db = ledger.db; this.provider = provider; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS gateway_quest_receipts(
      id TEXT PRIMARY KEY, person TEXT NOT NULL, idem TEXT NOT NULL, payload_hash TEXT NOT NULL,
      policy TEXT NOT NULL, day TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
      worst_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, state TEXT NOT NULL,
      usage TEXT, outcome TEXT, seal TEXT NOT NULL, UNIQUE(person,idem));`);
  }

  receipts() {
    return this.db.prepare('SELECT * FROM gateway_quest_receipts ORDER BY id').all().map(row => {
      demand(row.seal === seal(row), 'corrupt Quest receipt');
      demand(['reserved', 'dispatched', 'settled'].includes(row.state), 'corrupt Quest receipt state');
      demand(integer(row.charged_micros) && integer(row.worst_micros) && row.charged_micros <= row.worst_micros,
        'corrupt Quest accounting');
      return row;
    });
  }

  reserve(person, idem, input) {
    demand(typeof person === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(person), 'invalid Quest person');
    demand(typeof idem === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(idem), 'invalid idempotency key');
    return transaction(this.store, () => {
      demand(!killed(this.store), 'stopped run');
      const policy = this.ledger.policy(); demand(policy.enabled, 'gateway disabled');
      demand(input && typeof input === 'object' && !Array.isArray(input), 'invalid Quest payload');
      demand(input.model === this.ledger.rate.model && typeof input.input === 'string', 'model has no reviewed price');
      demand(Buffer.byteLength(input.input) <= policy.input_bytes, 'input byte limit');
      demand(integer(input.max_output_tokens) && input.max_output_tokens > 0 && input.max_output_tokens <= QUEST_LIMITS.output_tokens
        && input.max_output_tokens <= policy.output_tokens, 'output token limit');
      const hash = digest(canonical(input)); const existing = this.receipts().find(row => row.person === person && row.idem === idem);
      if (existing) { demand(existing.payload_hash === hash, 'idempotency payload conflict'); return { row: existing, fresh: false }; }
      const day = new Date(this.clock()).toISOString().slice(0, 10);
      const all = this.receipts(); const mine = all.filter(row => row.person === person && row.day === day);
      demand(mine.length < QUEST_LIMITS.calls_per_person_day, 'person daily call limit');
      const inputBound = Buffer.byteLength(input.input) + this.ledger.rate.framing_tokens;
      const worst = Number.isSafeInteger(this.ledger.rate.input_micros)
        ? inputBound * this.ledger.rate.input_micros + input.max_output_tokens * this.ledger.rate.output_micros
        : Math.ceil((inputBound * this.ledger.rate.input_micros_per_million + input.max_output_tokens * this.ledger.rate.output_micros_per_million) / 1_000_000);
      demand(integer(worst), 'unsafe accounting integer');
      const sum = rows => rows.reduce((total, row) => total + row.charged_micros, 0);
      demand(sum(mine) + worst <= QUEST_LIMITS.person_day_micros, 'person daily budget exceeded');
      const normal = this.ledger.receipts();
      demand(sum(normal) + sum(all) + worst <= policy.global_micros, 'global cap exceeded');
      demand(sum(normal.filter(row => row.day === day)) + sum(all.filter(row => row.day === day)) + worst <= policy.day_micros, 'day cap exceeded');
      const row = { id: digest(canonical(['quest', person, idem])), person, idem, payload_hash: hash, policy: canonical(policy), day,
        input_bound: inputBound, output_bound: input.max_output_tokens, worst_micros: worst, charged_micros: worst,
        state: 'reserved', usage: null, outcome: null };
      row.seal = seal(row);
      this.db.prepare(`INSERT INTO gateway_quest_receipts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      return { row, fresh: true };
    });
  }

  update(row, changes) {
    const next = { ...row, ...changes }; next.seal = seal(next);
    this.db.prepare('UPDATE gateway_quest_receipts SET state=?,charged_micros=?,usage=?,outcome=?,seal=? WHERE id=?')
      .run(next.state, next.charged_micros, next.usage, next.outcome, next.seal, next.id);
    return next;
  }

  async call(person, idem = randomUUID(), input) {
    const { row, fresh } = this.reserve(person, idem, input);
    if (!fresh) return this.outcome(row);
    this.update(row, { state: 'dispatched' });
    try {
      const result = await this.provider(Object.freeze({ ...input }), { id: row.id, person });
      demand(result && typeof result.output === 'string' && result.usage && integer(result.usage.input_tokens)
        && integer(result.usage.output_tokens) && result.usage.input_tokens <= row.input_bound
        && result.usage.output_tokens <= row.output_bound, 'invalid provider output');
      const charged = Number.isSafeInteger(this.ledger.rate.input_micros)
        ? result.usage.input_tokens * this.ledger.rate.input_micros + result.usage.output_tokens * this.ledger.rate.output_micros
        : Math.ceil((result.usage.input_tokens * this.ledger.rate.input_micros_per_million + result.usage.output_tokens * this.ledger.rate.output_micros_per_million) / 1_000_000);
      this.update(row, { state: 'settled', charged_micros: charged, usage: canonical(result.usage), outcome: canonical({ output: result.output }) });
    } catch { /* A dispatched hold remains worst-case until an administrator releases it. */ }
    return this.outcome(this.db.prepare('SELECT * FROM gateway_quest_receipts WHERE id=?').get(row.id));
  }

  outcome(row) {
    this.receipts();
    return row.state === 'settled' ? { status: 200, body: { id: row.id, output: JSON.parse(row.outcome).output } }
      : { status: 202, body: { id: row.id, state: row.state, held_micros: row.charged_micros } };
  }
}
