import { audienceCovers, canRead } from '../access/read.js';
import { isChallenged } from '../knowledge/corrections.js';

const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'has', 'was', 'were', 'are', 'not', 'new', 'old', 'our', 'their', 'your', 'will', 'can', 'need', 'needs', 'using']);
const terms = text => new Set(String(text || '').toLowerCase().match(/[a-z0-9_]+/g)?.filter(word => word.length > 1 && !stop.has(word)) || []);
export const shared = (a, b) => [...terms(a)].filter(word => terms(b).has(word)).sort();
const decisionTypes = new Set(['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew']);
export const sourceText = delta => delta.claims.map(claim => claim.text).join(' ');

// A reanalysis pass reads many results against the same frozen history. `ctx` holds what is expensive to rebuild
// (the target list, event hashes, stewards, read scopes) so one pass reads each item once, not once per result.
export const newContext = () => ({ targets: null, hashes: new Map(), steward: new Map(), scope: new Map() });
const memo = (map, key, make) => { if (!map.has(key)) map.set(key, make()); return map.get(key); };

function targets(store) {
  const found = [];
  for (const post of store.db.prepare("SELECT * FROM stage_posts WHERE closed_seq IS NOT NULL ORDER BY item,post_id").all()) {
    const events = store.eventRows(post.item).slice(post.opened_seq - 1, post.closed_seq).map(row => ({ row, event: store.eventFromRow(row) }));
    const decision = events.filter(({ event }) => decisionTypes.has(event.type)).at(-1);
    for (const { event } of events) for (const entry of event.ledger || []) found.push({ post, decision, cite: { kind: 'ledger', id: entry.id, quoted: entry.text }, text: entry.text });
    if (decision?.event.reason) found.push({ post, decision, cite: { kind: 'decision_reason', field: 'reason', quoted: decision.event.reason }, text: decision.event.reason });
    const metadata = decision?.event.metadata || {};
    for (const field of ['reconsider_if', 'trigger']) if (typeof metadata[field] === 'string') found.push({ post, decision, cite: { kind: 'condition', field, quoted: metadata[field] }, text: metadata[field] });
  }
  return found;
}

export function findImpacts(store, delta, { canRead: policy, ctx = newContext() } = {}) {
  if (isChallenged(store, delta.hash, delta.source?.body_hash)) return { checked: [], held: [] };
  const checked = [], held = [], deltaText = sourceText(delta);
  for (const candidate of (ctx.targets ??= targets(store))) {
    const target = candidate.post, decision_hash = candidate.decision?.row.body_hash || null;
    const common = shared(deltaText, candidate.text);
    const provenance = delta.provenance_roots || [];
    const duplicate = store.db.prepare('SELECT 1 FROM reanalysis_pairs WHERE delta_hash=? AND item=? AND decision_hash=?')
      .get(delta.body_hash, target.item, decision_hash || '');
    const body = { v: 1, delta: delta.body_hash, target: { item: target.item, post_id: target.post_id,
      snapshot_hash: target.snapshot_hash, decision_hash }, cites: [candidate.cite], shared_terms: common,
      why_this_case: `Recorded terms overlap: ${common.join(', ') || 'none'}.`,
      overlap_with_stated_reason: candidate.cite.kind === 'decision_reason' ? common.length >= 3 : Boolean(common.length >= 3 && candidate.decision?.event.reason && shared(deltaText, candidate.decision.event.reason).length >= 3) };
    const stewardOf = item => memo(ctx.steward, item, () => store.read(item).context.steward), scopeOf = item => memo(ctx.scope, item, () => store.readScope(item));
    const sourceViewer = stewardOf(delta.source.item);
    const targetViewer = stewardOf(target.item);
    const allowed = canRead(sourceViewer, scopeOf(delta.source.item), policy) && canRead(targetViewer, scopeOf(target.item), policy)
      && canRead(sourceViewer, scopeOf(target.item), policy)
      && audienceCovers(scopeOf(delta.source.item), scopeOf(target.item));   // the target's readers must be able to read the source it quotes
    // A result never reanalyzes the case it came from (or any case in its own provenance).
    const ownSource = delta.source.item === target.item || provenance.some(root => memo(ctx.hashes, target.item, () => new Set(store.eventRows(target.item).map(row => row.hash))).has(root));
    const qualifies = common.length >= 3 && allowed && !duplicate && !ownSource && delta.generation <= 2;
    (qualifies ? checked : held).push(body);
  }
  const unique = list => list.sort((a, b) => `${a.target.item}/${a.target.post_id}/${a.cites[0].quoted}`.localeCompare(`${b.target.item}/${b.target.post_id}/${b.cites[0].quoted}`)).slice(0, 5);
  return { checked: unique(checked), held: unique(held) };
}
