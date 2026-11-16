import { killed, transaction } from '../worker/control.js';
import { effortPrompt } from '../effort/prompt.js';
import { workspaceRecords } from '../research/workspace.js';
import { specDraftPrompt, parseSpecDraft, SPEC_DRAFT_PREFIX } from '../effort/spec.js';

const now = () => Date.now();
export const UNKNOWN_PROVIDER_STATUS = 'provider status/usage unknown; charged hold retained; awaiting reconciliation';
const currentAnchor = (context, kind) => kind === 'send' ? context.activePost?.version : kind === 'artifact' ? context.artifact : context[`${kind}Hash`];
export class EffortWorker {
  constructor(store, gateway, { clock = now } = {}) { this.store = store; this.db = store.db; this.gateway = gateway; this.clock = clock; this.ticking = false; }
  claim() { return transaction(this.store, () => {
    const job = this.db.prepare("SELECT * FROM effort_jobs WHERE state IN ('queued','running') AND (next_at IS NULL OR next_at<=?) ORDER BY created,id LIMIT 1").get(this.clock());
    if (!job) return null;
    const attempts = job.state === 'running' ? job.attempts : job.attempts + 1;
    // The deadline also fences the owner. Expired running jobs retain their
    // attempt so their existing receipt is recovered, never dispatched twice.
    const lease = Math.max(this.clock() + this.gateway.ledger.policy().timeout_ms + 5000, (job.next_at ?? 0) + 1);
    this.db.prepare("UPDATE effort_jobs SET state='running',attempts=?,next_at=? WHERE id=?").run(attempts, lease, job.id);
    return { ...job, attempts, lease };
  }); }
  async tick(options = {}) {
    if (this.ticking) return false;
    this.ticking = true;
    try { return await this.runTick(options); } finally { this.ticking = false; }
  }
  async runTick({ crashAfterCall = false } = {}) {
    const job = this.claim(); if (!job) return false;
    const state = this.store.read(job.item); const original = this.store.events(job.item)[0]?.original || '';
    try {
      const preparing = job.kind === 'spec_prepare';
      if (state.context.rules === 3 && (job.post_id !== state.context.activePost?.id || job.post_version !== state.context.activePost?.version)) throw Error('post superseded, not answered');
      const trigger = this.store.eventRows(job.item).find(event => event.seq === job.trigger_seq);
      const triggerBody = trigger && this.store.events(job.item).find(event => event.body_hash === trigger.body_hash);
      const anchor_kind = job.kind === 'spec_draft' ? 'spec' : job.kind === 'tag' ? triggerBody?.anchor_kind : 'see';
      const anchor_hash = job.kind === 'spec_draft' ? state.context.specHash : job.kind === 'tag' ? triggerBody?.anchor_hash : state.context.seeHash;
      if (!anchor_kind || !anchor_hash) throw Error('tag anchor unavailable');
      if (job.kind === 'tag' && currentAnchor(state.context, anchor_kind) !== anchor_hash) throw Error('outdated, not answered');
      const prompt = preparing ? specDraftPrompt(this.store.events(job.item).slice(0, job.trigger_seq), this.gateway.ledger.policy().input_bytes)
        : effortPrompt(original, this.store.events(job.item), {
          workspaceRecords: workspaceRecords(this.store, job.requester, job.item, original),
          anchorKind: anchor_kind, anchorHash: anchor_hash, trigger: job.kind === 'tag' ? triggerBody : undefined,
          maxBytes: Math.min(6000, this.gateway.ledger.policy().input_bytes),
        });
      if (preparing && (state.context.seeHash !== prompt.seeHash || state.context.steward !== job.requester || state.state !== 'SEEN')) throw Error('outdated SPEC request');
      const idem = `effort:${job.id}:a${job.attempts}`;
      // Recover a prior dispatch by receipt, even if intervening discussion
      // changed the newly constructed prompt. Never retry an unknown charge.
      const receipt = this.gateway.receipts().find(row => row.person === job.requester && row.idem === idem);
      if (receipt && (killed(this.store) || !this.gateway.ledger.policy().enabled)) {
        this.db.prepare("UPDATE effort_jobs SET last_error=? WHERE id=? AND state='running' AND next_at=?").run('gateway disabled or stopped; awaiting resume', job.id, job.lease);
        return false;
      }
      const result = receipt ? this.gateway.outcome(receipt) : await this.gateway.call(job.requester, idem,
        { model: this.gateway.ledger.rate.model, input: prompt.input, max_output_tokens: preparing ? 1024 : 128 }, job.item, job.id);
      // 202 means an unknown charged dispatch. Retain this attempt and hold;
      // an expired lease may check the same receipt, not start another call.
      if (result.status !== 200) {
        this.db.prepare("UPDATE effort_jobs SET last_error=? WHERE id=? AND state='running' AND next_at=?").run(UNKNOWN_PROVIDER_STATUS, job.id, job.lease);
        return false;
      }
      if (crashAfterCall) {
        this.db.prepare("UPDATE effort_jobs SET next_at=? WHERE id=? AND state='running' AND next_at=?").run(this.clock() - 1, job.id, job.lease);
        return false;
      }
      // A mention is a reply to one exact comment and version. Do not move it to
      // the newest version if that version changed while Effort was thinking.
      if (job.kind === 'tag' && currentAnchor(state.context, anchor_kind) !== anchor_hash) throw Error('outdated, not answered');
      const comment = preparing ? SPEC_DRAFT_PREFIX + JSON.stringify(parseSpecDraft(result.body.output))
        : `${job.kind === 'spec_draft' ? 'Use as starting point: ' : ''}${result.body.output}`;
      return transaction(this.store, () => {
        const owner = this.db.prepare("SELECT 1 FROM effort_jobs WHERE id=? AND state='running' AND next_at=?").get(job.id, job.lease);
        if (!owner) return false;
        if (killed(this.store) || !this.gateway.ledger.policy().enabled) {
          this.db.prepare("UPDATE effort_jobs SET last_error=? WHERE id=? AND state='running' AND next_at=?").run('gateway disabled or stopped; awaiting resume', job.id, job.lease);
          return false;
        }
        const current = this.store.read(job.item);
        if (current.context.rules === 3 && (job.post_id !== current.context.activePost?.id || job.post_version !== current.context.activePost?.version)) throw Error('post superseded, not answered');
        if (job.kind === 'tag' && currentAnchor(current.context, anchor_kind) !== anchor_hash) throw Error('outdated, not answered');
        if (preparing && (this.store.read(job.item).context.seeHash !== prompt.seeHash || this.store.read(job.item).context.steward !== job.requester)) throw Error('outdated SPEC request');
        this.store.appendInTransaction(job.item, { type: 'commented', actor: 'effort', ...(job.post_id ? { post_id: job.post_id, post_version: job.post_version } : {}), comment, kind: 'agent', job: job.id, receipt: result.body.id, model: result.body.model, anchor_kind, anchor_hash, ...(job.kind === 'tag' ? { parent: triggerBody.body_hash } : {}), at: new Date(this.clock()).toISOString() }, { idem: `effort:${job.id}` });
        this.db.prepare("UPDATE effort_jobs SET state='done',last_error=NULL,next_at=NULL WHERE id=?").run(job.id);
        return true;
      });
    } catch (error) {
      // A receipt proves a dispatch may have happened; keep its attempt.
      const idem = `effort:${job.id}:a${job.attempts}`;
      if (this.gateway.receipts().some(row => row.person === job.requester && row.idem === idem && row.state !== 'settled')) {
        this.db.prepare("UPDATE effort_jobs SET last_error=? WHERE id=? AND state='running' AND next_at=?").run(UNKNOWN_PROVIDER_STATUS, job.id, job.lease);
        return false;
      }
      const message = String(error.message || error); const blocked = /gateway disabled|stopped run|daily|superseded|frozen/.test(message);
      this.db.prepare("UPDATE effort_jobs SET state=?,last_error=?,next_at=? WHERE id=? AND state='running' AND next_at=?").run(blocked ? 'blocked' : job.attempts >= 3 ? 'failed' : 'queued', message, this.clock(), job.id, job.lease);
      return false;
    }
  }
}
