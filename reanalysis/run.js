import { parseAt } from '../core/reconcile.js';
import { defaultCanRead, canRead } from '../access/read.js';
import { extractDeltas } from '../knowledge/delta.js';
import { findImpacts } from './match.js';
import { deliverToOpenThreads } from './open.js';
import { buildAnnex, recordAnnex } from './annex.js';
import { deliverAnnexes } from '../notifications/digest.js';
import { catalogCapabilities } from '../knowledge/catalog.js';
import { propagateOpportunities } from './propagate.js';

const DAY = 7 * 24 * 60 * 60 * 1000;

function cooled(store, impact, delta, now) {
  const rows = store.knowledge.entries('impact');
  return rows.some(row => row.body.target.item === impact.target.item && row.body.target.post_id === impact.target.post_id
    && parseAt(now) - parseAt(row.at) < DAY && row.body.provenance !== (delta.provenance_roots || []).join(','));
}

export function runReanalysis(store, { now, limit = 20, canRead: policy = defaultCanRead } = {}) {
  if (!Number.isFinite(parseAt(now))) throw new Error('now timestamp required');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const deltas = extractDeltas(store, { now, limit });
  const annexes = [], held = [], receipts = [], skipped = [], openThreads = [];
  for (const delta of deltas) {
    const match = findImpacts(store, delta, { canRead: policy });
    held.push(...match.held);
    openThreads.push(...deliverToOpenThreads(store, delta, { now, canRead: policy }));
    for (const impact of match.checked) {
      const viewer = store.read(delta.source.item).context.steward;
      if (!canRead(viewer, store.readScope(delta.source.item), policy) || !canRead(viewer, store.readScope(impact.target.item), policy)) { held.push(impact); continue; }
      const pair = store.db.prepare('SELECT 1 FROM reanalysis_pairs WHERE delta_hash=? AND item=? AND decision_hash=?')
        .get(delta.body_hash, impact.target.item, impact.target.decision_hash || '');
      if (pair || cooled(store, impact, delta, now)) { skipped.push(impact); continue; }
      const impactEntry = store.knowledge.append('impact', { ...impact, provenance: (delta.provenance_roots || []).join(',') }, { at: now });
      const annex = recordAnnex(store, buildAnnex(delta, impact), { at: now });
      store.db.prepare('INSERT OR IGNORE INTO reanalysis_pairs(delta_hash,item,decision_hash,provenance,created_at) VALUES(?,?,?,?,?)')
        .run(delta.body_hash, impact.target.item, impact.target.decision_hash || '', (delta.provenance_roots || []).join(','), now);
      annexes.push({ ...annex, impact: impactEntry.hash });
    }
    const receipt = store.knowledge.append('receipt', { v: 1, kind: 'reanalysis_run', delta: delta.body_hash,
      searched: 'frozen ledger entries, decision reasons, and volunteered conditions', k: 5,
      negatives: match.held.length, duplicates: delta.duplicate ? 1 : 0,
      components: ['deterministic_overlap', 'access_read'], counts: { checked: match.checked.length, held: match.held.length } }, { at: now });
    receipts.push(receipt);
  }
  const capabilities = catalogCapabilities(store, { at: now });
  const edges = propagateOpportunities(store, { at: now });
  const delivery = deliverAnnexes(store, { now, canRead: policy });
  return { deltas, annexes, held, receipts, skipped, capabilities, edges, delivery, openThreads };
}
