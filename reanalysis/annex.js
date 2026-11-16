import { canonical } from '../knowledge/chain.js';

export function buildAnnex(delta, impact, advisory = null) {
  const sourceQuotes = delta.claims.map(claim => claim.text);
  const bearing = impact.cites.map(cite => cite.quoted);
  return { v: 1, authoritative_for_original_stage: false,
    parent: impact.target, what_is_new: sourceQuotes, bears_on: bearing,
    why_matched: impact.why_this_case,
    not_known: impact.overlap_with_stated_reason ? ['Whether this new information changes a later decision.']
      : ['No overlap with the stated reason found.', 'Whether this new information changes a later decision.'],
    ...(advisory ? { known_unknowns: advisory.known_unknowns, contrary: advisory.contrary } : {}),
    statement: 'Found by Effort (AI). This does not change the earlier decision.',
    delta: delta.body_hash, impact: canonical(impact) };
}

export function recordAnnex(store, body, { at } = {}) {
  // Public callers need not supply a clock. The frozen snapshot timestamp is
  // deterministic data and keeps this helper free of wall-clock reads.
  const timestamp = at || store.eventRows(body.parent.item).find(row => row.hash === body.parent.snapshot_hash)?.at;
  if (typeof timestamp !== 'string' || !timestamp) throw new Error('annex parent timestamp required');
  const annex = store.knowledge.append('annex', body, { at: timestamp });
  const receipt = store.knowledge.append('receipt', { v: 1, kind: 'annex_recorded', annex: annex.hash, parent: body.parent }, { at: timestamp });
  return { hash: annex.hash, receipt: receipt.hash, duplicate: annex.duplicate };
}
