import { createHash, randomUUID } from 'node:crypto';
import { killed, transaction } from '../worker/control.js';
import { canonical } from './ledger.js';

export const EFFORT_LIMITS = Object.freeze({ calls_per_person_day: 3, output_tokens: 256, person_day_micros: 100_000 });
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const demand = (value, message) => { if (!value) throw Error(message); };
const seal = row => { const { seal: ignored, ...body } = row; return digest(canonical(body)); };

export class EffortGateway {
  constructor(ledger, provider, { clock = Date.now } = {}) { demand(typeof provider === 'function', 'Effort provider required'); this.ledger = ledger; this.store = ledger.store; this.db = ledger.db; this.provider = provider; this.clock = clock; }
  receipts() { return this.ledger.effortReceipts(); }
  reserve(person, idem, input, item, job) {
    demand(typeof person === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(person), 'invalid Effort person');
    demand(typeof idem === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(idem), 'invalid idempotency key');
    return transaction(this.store, () => {
      demand(!killed(this.store), 'stopped run'); const policy = this.ledger.policy(); demand(policy.enabled, 'gateway disabled');
      const { inputBound, worst } = this.ledger.validateInput(input, policy);
      demand(input.max_output_tokens <= EFFORT_LIMITS.output_tokens, 'output token limit');
      const hash = digest(canonical(input)); const all = this.receipts(); const existing = all.find(row => row.person === person && row.idem === idem);
      if (existing) { demand(existing.payload_hash === hash, 'idempotency payload conflict'); return { row: existing, fresh: false }; }
      const day = new Date(this.clock()).toISOString().slice(0, 10); const mine = all.filter(row => row.person === person && row.day === day);
      const sum = rows => rows.reduce((total, row) => total + row.charged_micros, 0);
      demand(mine.length < EFFORT_LIMITS.calls_per_person_day, 'person daily call limit');
      demand(sum(mine) + worst <= EFFORT_LIMITS.person_day_micros, 'person daily budget exceeded');
      const combined = this.ledger.allMeteredReceipts();
      demand(sum(combined) + worst <= policy.global_micros, 'global cap exceeded');
      demand(sum(combined.filter(row => row.day === day)) + worst <= policy.day_micros, 'day cap exceeded');
      const row = { id: digest(canonical(['effort', person, idem])), person, idem, payload_hash: hash, policy: canonical(policy), day, input_bound: inputBound, output_bound: input.max_output_tokens, worst_micros: worst, charged_micros: worst, state: 'reserved', usage: null, outcome: null, item, job };
      row.seal = seal(row); this.db.prepare(`INSERT INTO gateway_effort_receipts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      return { row, fresh: true };
    });
  }
  update(row, changes) { const next = { ...row, ...changes }; next.seal = seal(next); this.db.prepare('UPDATE gateway_effort_receipts SET state=?,charged_micros=?,usage=?,outcome=?,seal=? WHERE id=?').run(next.state, next.charged_micros, next.usage, next.outcome, next.seal, next.id); return next; }
  async call(person, idem = randomUUID(), input, item, job) {
    const { row, fresh } = this.reserve(person, idem, input, item, job); if (!fresh) return this.outcome(row);
    this.update(row, { state: 'dispatched' });
    try { const result = await this.provider(Object.freeze({ ...input }), { id: row.id, person, item, job });
      demand(result && typeof result.output === 'string' && result.usage && integer(result.usage.input_tokens) && integer(result.usage.output_tokens) && result.usage.input_tokens <= row.input_bound && result.usage.output_tokens <= row.output_bound, 'invalid provider output');
      const charged = this.ledger.cost({ ...row, rate: canonical(this.ledger.rate) }, result.usage); this.update(row, { state: 'settled', charged_micros: charged, usage: canonical(result.usage), outcome: canonical({ output: result.output }) });
    } catch { /* A dispatched hold stays charged until an operator reviews it. */ }
    return this.outcome(this.db.prepare('SELECT * FROM gateway_effort_receipts WHERE id=?').get(row.id));
  }
  outcome(row) { this.receipts(); return row.state === 'settled' ? { status: 200, body: { id: row.id, output: JSON.parse(row.outcome).output } } : { status: 202, body: { id: row.id, state: row.state, held_micros: row.charged_micros } }; }
}
