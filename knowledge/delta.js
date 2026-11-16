import { parseAt } from '../core/reconcile.js';

const decisionEvents = new Set(['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew']);
const triggers = event => {
  if (event.type === 'helped') return 'helped';
  if (event.type === 'experiment_not_helpful') return 'experiment_not_helpful';
  if (event.type === 'failed') return 'run_failed';
  if (event.type === 'researched') return 'researched';
  if (event.type === 'specced' && Array.isArray(event.estimates) && event.estimates.length) return 'spec_estimates';
  if (decisionEvents.has(event.type)) return 'decision';
  return null;
};
const ignored = new Set(['type', 'actor', 'at', 'post_id', 'post_version', 'body_hash', 'packet_hash', 'spec_hash', 'see_hash', 'artifact_hash', 'base_hash', 'approval', 'iteration', 'ledger', 'estimates', 'disposition', 'reason_code']);
const texts = (value, key = '') => {
  if (typeof value === 'string') return ignored.has(key) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(entry => typeof entry === 'string' ? [entry] : []);
  if (value && typeof value === 'object' && key === 'sources') return Object.values(value).flatMap(entry => typeof entry?.finding === 'string' ? [entry.finding] : []);
  return [];
};
const claimsFor = (event, epistemic) => [...new Set(Object.entries(event).flatMap(([key, value]) => texts(value, key)))]
  .filter(text => text.length > 0).map(text => ({ text, epistemic }));

// Only event rows are inputs. In particular, the AI log is intentionally never read here.
export function extractDeltas(store, { now, limit = Infinity } = {}) {
  if (!Number.isFinite(parseAt(now))) throw new Error('now timestamp required');
  const deltas = [];
  const items = store.db.prepare('SELECT DISTINCT item FROM events ORDER BY item').all();
  for (const { item } of items) {
    const cursor = store.db.prepare('SELECT seq FROM reanalysis_cursor WHERE item=?').get(item)?.seq || 0;
    for (const row of store.eventRows(item).filter(row => row.seq > cursor)) {
      if (deltas.length >= limit) break;
      const event = store.eventFromRow(row), trigger = triggers(event);
      const actor = store.authorityFromRow(row);
      // An agent's words, including Effort's own comments, can never be a delta.
      if (trigger && actor.kind !== 'agent') {
        const epistemic = actor.kind === 'source' ? 'system' : event.type === 'researched' ? 'documented' : 'observed';
        // A terminal HELP event normally carries only an artifact hash. Its useful
        // recorded context is the preceding human SPEC, never an AI artifact.
        const direct = claimsFor(event, epistemic);
        const prior = store.eventRows(item).filter(value => value.seq < row.seq).map(value => ({ row: value, event: store.eventFromRow(value) }))
          .filter(value => store.authorityFromRow(value.row).kind !== 'agent').reverse().find(value => claimsFor(value.event, epistemic).length)?.event;
        const claims = direct.concat(direct.length ? [] : claimsFor(prior || {}, epistemic));
        if (claims.length) {
          const body = { v: 1, source: { item, seq: row.seq, event_hash: row.hash, body_hash: row.body_hash }, trigger, claims,
            provenance_roots: [row.hash], generation: 0 };
          const entry = store.knowledge.append('delta', body, { at: now });
          deltas.push({ ...body, hash: entry.hash, body_hash: entry.body_hash, duplicate: entry.duplicate });
        }
      }
      store.db.prepare(`INSERT INTO reanalysis_cursor(item,seq) VALUES(?,?)
        ON CONFLICT(item) DO UPDATE SET seq=excluded.seq WHERE excluded.seq > reanalysis_cursor.seq`).run(item, row.seq);
    }
  }
  return deltas;
}
