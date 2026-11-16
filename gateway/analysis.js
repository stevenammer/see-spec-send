import { createHash } from 'node:crypto';
import { canonical } from './ledger.js';

export const ANALYSIS_LIMITS = Object.freeze({ calls_per_person_day: 3, output_tokens: 1024, person_day_micros: 100_000, job_class: 'analysis' });
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const demand = (value, message) => { if (!value) throw Error(message); };
const seal = row => { const { seal: ignored, ...body } = row; return hash(canonical(body)); };

// Operator-created only. Nothing constructs this gateway by default, so a local
// Investigate run remains sources-only until an operator deliberately enables it.
export class AnalysisGateway {
  constructor(ledger, provider, { clock = Date.now } = {}) { demand(typeof provider === 'function', 'analysis provider required'); this.ledger = ledger; this.db = ledger.db; this.provider = provider; this.clock = clock; }
  receipts() { return this.db.prepare('SELECT * FROM gateway_analysis_receipts ORDER BY id').all().map(row => { demand(row.seal === seal(row), 'corrupt analysis receipt'); return row; }); }
  async ask(person, idem, promptPackage) {
    demand(typeof person === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(person), 'invalid analysis person');
    const input = JSON.stringify(promptPackage), policy = this.ledger.policy(), outputLimit = Math.min(ANALYSIS_LIMITS.output_tokens, policy.output_tokens); demand(policy.enabled, 'gateway disabled');
    demand(Buffer.byteLength(input) <= policy.input_bytes, 'input byte limit');
    const day = new Date(this.clock()).toISOString().slice(0, 10), all = this.receipts(), mine = all.filter(row => row.person === person && row.day === day);
    demand(mine.length < ANALYSIS_LIMITS.calls_per_person_day, 'analysis daily call limit');
    const inputBound = Buffer.byteLength(input) + this.ledger.rate.framing_tokens;
    const worst = this.ledger.cost({ input_bound: inputBound, output_bound: outputLimit, rate: canonical(this.ledger.rate) }, { input_tokens: inputBound, output_tokens: outputLimit });
    demand(mine.reduce((n, row) => n + row.charged_micros, 0) + worst <= ANALYSIS_LIMITS.person_day_micros, 'analysis daily budget exceeded');
    const metered = this.ledger.allMeteredReceipts();
    demand(metered.reduce((n, row) => n + row.charged_micros, 0) + worst <= policy.global_micros, 'global cap exceeded');
    demand(metered.filter(row => row.day === day).reduce((n, row) => n + row.charged_micros, 0) + worst <= policy.day_micros, 'day cap exceeded');
    const payload_hash = hash(input), existing = all.find(row => row.person === person && row.idem === idem);
    if (existing) { demand(existing.payload_hash === payload_hash, 'idempotency payload conflict'); return JSON.parse(existing.outcome).output; }
    const row = { id: hash(canonical(['analysis', person, idem])), person, idem, payload_hash, policy: canonical(policy), day, input_bound: inputBound, output_bound: outputLimit, worst_micros: worst, charged_micros: worst, state: 'dispatched', usage: null, outcome: null, job_class: ANALYSIS_LIMITS.job_class };
    row.seal = seal(row); this.db.prepare(`INSERT INTO gateway_analysis_receipts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    try { const result = await this.provider(Object.freeze({ model: this.ledger.rate.model, input, max_output_tokens: outputLimit }), { id: row.id, person, job_class: ANALYSIS_LIMITS.job_class });
      demand(result && typeof result.output === 'string' && result.usage && integer(result.usage.input_tokens) && integer(result.usage.output_tokens), 'invalid provider output');
      const charged = this.ledger.cost({ ...row, rate: canonical(this.ledger.rate) }, result.usage); const settled = { ...row, state: 'settled', charged_micros: charged, usage: canonical(result.usage), outcome: canonical({ output: result.output }) }; settled.seal = seal(settled);
      this.db.prepare('UPDATE gateway_analysis_receipts SET state=?,charged_micros=?,usage=?,outcome=?,seal=? WHERE id=?').run(settled.state, settled.charged_micros, settled.usage, settled.outcome, settled.seal, settled.id); return result.output;
    } catch { throw Error('analysis provider did not return a settled answer'); }
  }
}
