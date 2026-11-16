import { canRead } from '../access/read.js';
import { shared, sourceText } from './match.js';
import { parseAt } from '../core/reconcile.js';

// A new result can bear on work that is still being discussed. There the right
// place is the live thread: one disclosed, labeled AI comment that quotes the
// recorded sources and changes nothing. It never edits the post, never counts as
// a contribution of a person, and is limited so a thread is not flooded.
export const MIN_SHARED_TERMS = 3;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const open = new Set(['SEEN', 'CHECKED', 'SPECCED']);

function openTargets(store) {
  const found = [];
  for (const { item } of store.db.prepare("SELECT DISTINCT item FROM events ORDER BY item").all()) {
    const state = store.read(item), post = state.context.activePost;
    if (state.context.rules !== 3 || !post || !open.has(state.state) || post.kind !== 'spec') continue;
    const spec = store.events(item).filter(event => event.type === 'specced').at(-1);
    if (!spec) continue;
    for (const entry of spec.ledger || []) found.push({ item, state, post, spec, entry });
  }
  return found;
}

export function deliverToOpenThreads(store, delta, { now, canRead: policy, ctx = {} } = {}) {
  const posted = [], text = sourceText(delta);
  for (const target of (ctx.open ??= openTargets(store))) {
    if (target.item === delta.source.item) continue;                                 // never its own case
    if ((delta.provenance_roots || []).some(root => (ctx.hashes ??= new Map(), ctx.hashes.has(target.item) ? ctx.hashes : ctx.hashes.set(target.item, new Set(store.eventRows(target.item).map(row => row.hash)))).get(target.item).has(root))) continue;
    const viewer = target.state.context.steward;
    if (!canRead(viewer, store.readScope(delta.source.item), policy) || !canRead(viewer, store.readScope(target.item), policy)) continue;
    const common = shared(text, target.entry.text);
    if (common.length < MIN_SHARED_TERMS || delta.generation > 2) continue;
    const pair = `open:${target.post.id}:${target.post.version}:${target.entry.id}`;
    if (store.db.prepare('SELECT 1 FROM reanalysis_pairs WHERE delta_hash=? AND item=? AND decision_hash=?').get(delta.body_hash, target.item, pair)) continue;
    const recent = store.db.prepare("SELECT created_at FROM reanalysis_pairs WHERE item=? AND decision_hash LIKE 'open:%' ORDER BY created_at DESC LIMIT 1").get(target.item);
    if (recent && parseAt(now) - parseAt(recent.created_at) < WEEK) continue;      // at most one a week per thread
    const comment = `Found by Effort (AI). A recorded result elsewhere may bear on an assumption here. What is new: ${delta.claims.map(claim => claim.text).join(' ')} `
      + `It bears on: ${target.entry.text} Shared terms: ${common.join(', ')}. This is a prompt for the people on this thread; it does not change the spec or any decision. No overlap is claimed beyond those terms.`;
    if (comment.length > 4000) continue;
    store.append(target.item, { type: 'commented', actor: 'effort', kind: 'agent', comment, job: `reanalysis:${delta.body_hash}`, receipt: delta.body_hash,
      model: 'deterministic', anchor_kind: 'spec', anchor_hash: target.state.context.specHash, post_id: target.post.id, post_version: target.post.version, at: now },
    { idem: `reanalysis-open:${delta.body_hash}:${target.item}:${pair}` });
    store.db.prepare('INSERT OR IGNORE INTO reanalysis_pairs(delta_hash,item,decision_hash,provenance,created_at) VALUES(?,?,?,?,?)')
      .run(delta.body_hash, target.item, pair, (delta.provenance_roots || []).join(','), now);
    store.knowledge.append('receipt', { v: 1, kind: 'open_thread_comment', delta: delta.body_hash, target: { item: target.item, post_id: target.post.id }, shared_terms: common }, { at: now });
    posted.push({ item: target.item, entry: target.entry.id });
  }
  return posted;
}
