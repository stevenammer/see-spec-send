import { reconciliation } from './reconcile.js';

const decisionOutcome = event => ({
  approved: 'approve',
  returned: 'return',
  not_built: 'resolve_without_build',
  experiment_not_helpful: 'experiment_did_not_help',
  op_withdrew: 'op_withdrew',
}[event.type] || event.disposition);

const ref = event => ({ seq: event.seq, body_hash: event.body_hash });
const erased = event => event.erased === true;
const entry = (event, value = {}) => ({ ...ref(event), erased: erased(event), ...value });
const snapshotEvents = (events, post) => events.filter(event => event.seq >= post.opened_seq && event.seq <= post.closed_seq);
const decisionTypes = new Set(['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew']);

// This intentionally extracts only recorded fields. It does not score, infer,
// summarize, or make a finding about anyone.
export function buildCloseout(events, post, snapshot) {
  if (!post || !Number.isInteger(post.opened_seq) || !Number.isInteger(post.closed_seq)
    || typeof post.snapshot_hash !== 'string' || !snapshot || snapshot.hash !== post.snapshot_hash)
    throw new Error('frozen post snapshot required');
  const frozen = snapshotEvents(events, post);
  const byHash = new Map(events.map(event => [event.body_hash, event]));
  const reconciliationReport = reconciliation(frozen, {
    posts: [{ post_id: post.post_id, closed_seq: post.closed_seq }], terminal: true,
  });
  const reconciliationByHash = new Map(reconciliationReport.contributions.map(value => [value.hash, value]));
  const evidence = frozen.flatMap(event => (event.evidence || []).map(value =>
    entry(event, { evidence_kind: value.kind, source: value, status: erased(event) ? 'erased' : 'recorded' })));
  const credits = frozen.flatMap(event => (event.credits || []).map(credit => {
    const original = byHash.get(credit.comment);
    return entry(event, { mode: credit.mode, original_attribution: original
      ? { actor: original.actor, ...ref(original), erased: erased(original) }
      : { status: 'unavailable or erased' } });
  }));
  return {
    version: 1,
    item: post.item,
    post: { id: post.post_id, kind: post.kind, opened_seq: post.opened_seq, closed_seq: post.closed_seq,
      snapshot_hash: post.snapshot_hash },
    facts: evidence.filter(value => ['observed', 'documented'].includes(value.evidence_kind)),
    reported_claims: evidence.filter(value => value.evidence_kind === 'reported'),
    assumptions: frozen.flatMap(event => (event.assumptions || []).map(value => entry(event, { value, status: erased(event) ? 'erased' : 'recorded' }))),
    open_questions: frozen.flatMap(event => (event.open_questions || []).map(value => entry(event, { value, status: erased(event) ? 'erased' : 'recorded' }))),
    discussion: frozen.filter(event => event.type === 'commented' && ['question', 'concern', 'alternative'].includes(event.kind))
      .map(event => entry(event, { type: event.kind, text: erased(event) ? '[erased]' : event.comment,
        reconciliation_status: event.kind === 'alternative' ? reconciliationByHash.get(event.body_hash)?.status || 'not_applicable' : 'not_applicable' })),
    credits,
    decisions: frozen.filter(event => decisionTypes.has(event.type)).map(event => entry(event, {
      outcome: decisionOutcome(event), reason: erased(event) ? '[erased]' : event.reason,
      reason_code: erased(event) ? '[erased]' : event.reason_code,
      metadata: erased(event) ? '[erased]' : event.metadata,
    })),
    disagreements_unresolved_at_freeze: reconciliationReport.contributions
      .filter(value => value.status === 'unresolved_at_freeze')
      .map(value => ({ seq: value.seq, body_hash: value.hash, erased: Boolean(byHash.get(value.hash)?.erased), status: value.status })),
    next_stage: post.successor_post_id ? { post_id: post.successor_post_id, ...ref(frozen.at(-1) || { seq: post.closed_seq, body_hash: snapshot.body_hash || '' }) } : null,
  };
}

function jobEvents(store, item) {
  return store.eventRows(item).map(row => ({ ...store.eventFromRow(row), seq: row.seq,
    erased: store.db.prepare('SELECT erased FROM bodies WHERE hash=?').get(row.body_hash)?.erased === 1 }));
}

export function runCloseoutJobs(store, { limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('closeout limit out of range');
  const jobs = store.db.prepare("SELECT * FROM closeout_jobs WHERE state='pending' ORDER BY item,post_id LIMIT ?").all(limit);
  let done = 0;
  for (const job of jobs) {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const current = store.db.prepare('SELECT * FROM closeout_jobs WHERE item=? AND post_id=? AND snapshot_hash=?')
        .get(job.item, job.post_id, job.snapshot_hash);
      if (!current || current.state === 'done') { store.db.exec('COMMIT'); continue; }
      const post = store.db.prepare('SELECT * FROM stage_posts WHERE item=? AND post_id=? AND snapshot_hash=? AND closed_seq IS NOT NULL')
        .get(job.item, job.post_id, job.snapshot_hash);
      if (!post) throw new Error('closeout post is unavailable');
      const closing = store.eventRows(job.item).find(row => row.hash === job.snapshot_hash);
      if (!closing) throw new Error('closeout snapshot is unavailable');
      const report = buildCloseout(jobEvents(store, job.item), post, { hash: job.snapshot_hash, body_hash: closing.body_hash });
      const artifact_hash = store.putArtifact(job.item, JSON.stringify(report));
      const updated = store.db.prepare("UPDATE closeout_jobs SET state='done',artifact_hash=? WHERE item=? AND post_id=? AND snapshot_hash=? AND state='pending'")
        .run(artifact_hash, job.item, job.post_id, job.snapshot_hash);
      if (updated.changes === 1) done++;
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  return { processed: done };
}
