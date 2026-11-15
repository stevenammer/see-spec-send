import { transaction } from '../worker/control.js';
import { effortPrompt } from '../effort/prompt.js';
import { workspaceRecords } from '../research/workspace.js';
import { specDraftPrompt, parseSpecDraft, SPEC_DRAFT_PREFIX } from '../effort/spec.js';

const now = () => Date.now();
const currentAnchor = (context, kind) => kind === 'send' ? context.activePost?.version : kind === 'artifact' ? context.artifact : context[`${kind}Hash`];
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
      const result = await this.gateway.call(job.requester, `effort:${job.id}:a${job.attempts}`, { model: this.gateway.ledger.rate.model, input: prompt.input, max_output_tokens: preparing ? 1024 : 128 }, job.item, job.id);
      if (result.status !== 200) throw Error('provider failed');
      if (crashAfterCall) return false;
      // A mention is a reply to one exact comment and version. Do not move it to
      // the newest version if that version changed while Effort was thinking.
      if (job.kind === 'tag' && currentAnchor(state.context, anchor_kind) !== anchor_hash) throw Error('outdated, not answered');
      const comment = preparing ? SPEC_DRAFT_PREFIX + JSON.stringify(parseSpecDraft(result.body.output))
        : `${job.kind === 'spec_draft' ? 'Use as starting point: ' : ''}${result.body.output}`;
      transaction(this.store, () => {
        if (preparing && (this.store.read(job.item).context.seeHash !== prompt.seeHash || this.store.read(job.item).context.steward !== job.requester)) throw Error('outdated SPEC request');
        this.store.appendInTransaction(job.item, { type: 'commented', actor: 'effort', ...(job.post_id ? { post_id: job.post_id, post_version: job.post_version } : {}), comment, kind: 'agent', job: job.id, receipt: result.body.id, model: this.gateway.ledger.rate.model, anchor_kind, anchor_hash, ...(job.kind === 'tag' ? { parent: triggerBody.body_hash } : {}), at: new Date(this.clock()).toISOString() }, { idem: `effort:${job.id}` });
        this.db.prepare("UPDATE effort_jobs SET state='done',last_error=NULL WHERE id=?").run(job.id);
      });
      return true;
    } catch (error) {
      const message = String(error.message || error); const blocked = /gateway disabled|stopped run|daily|superseded|frozen/.test(message);
      this.db.prepare('UPDATE effort_jobs SET state=?,last_error=?,next_at=? WHERE id=?').run(blocked ? 'blocked' : job.attempts >= 3 ? 'failed' : 'queued', message, this.clock(), job.id);
      return false;
    }
  }
}
