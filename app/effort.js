import { transaction } from '../worker/control.js';
import { effortPrompt } from '../effort/prompt.js';

const now = () => Date.now();
export class EffortWorker {
  constructor(store, gateway, { clock = now } = {}) { this.store = store; this.db = store.db; this.gateway = gateway; this.clock = clock; }
  claim() { return transaction(this.store, () => {
    const job = this.db.prepare("SELECT * FROM effort_jobs WHERE state IN ('queued','running') AND (next_at IS NULL OR next_at<=?) ORDER BY created,id LIMIT 1").get(this.clock());
    if (!job) return null;
    const attempts = job.state === 'running' ? job.attempts : job.attempts + 1;
    this.db.prepare("UPDATE effort_jobs SET state='running',attempts=? WHERE id=?").run(attempts, job.id);
    return { ...job, attempts };
  }); }
  async tick({ crashAfterCall = false } = {}) {
    const job = this.claim(); if (!job) return false;
    const state = this.store.read(job.item); const original = this.store.events(job.item)[0]?.original || '';
    const prompt = effortPrompt(original, this.store.events(job.item));
    try {
      const result = await this.gateway.call(job.requester, `effort:${job.id}:a${job.attempts}`, { model: this.gateway.ledger.rate.model, input: prompt.input, max_output_tokens: 128 }, job.item, job.id);
      if (result.status !== 200) throw Error('provider failed');
      if (crashAfterCall) return false;
      const anchor_kind = job.kind === 'spec_first' ? 'spec' : 'see'; const anchor_hash = anchor_kind === 'spec' ? state.context.specHash : state.context.seeHash;
      transaction(this.store, () => {
        this.store.appendInTransaction(job.item, { type: 'commented', actor: 'effort', comment: result.body.output, kind: 'agent', job: job.id, receipt: result.body.id, model: this.gateway.ledger.rate.model, anchor_kind, anchor_hash, at: new Date(this.clock()).toISOString() }, { idem: `effort:${job.id}` });
        this.db.prepare("UPDATE effort_jobs SET state='done',last_error=NULL WHERE id=?").run(job.id);
      });
      return true;
    } catch (error) {
      const message = String(error.message || error); const blocked = /gateway disabled|stopped run|daily/.test(message);
      this.db.prepare('UPDATE effort_jobs SET state=?,last_error=?,next_at=? WHERE id=?').run(blocked ? 'blocked' : job.attempts >= 3 ? 'failed' : 'queued', message, this.clock(), job.id);
      return false;
    }
  }
}
