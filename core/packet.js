export { RESEARCH_SOURCES } from '../research/connectors.js';
import { RESEARCH_SOURCES } from '../research/connectors.js';

// Deterministic, deliberately plain decision packet. It describes unavailable
// research instead of pretending that a connector checked it.
export function buildPacket({ original, see, spec, credits = [], comments = [], gatewayPolicy = {}, sandboxLimits = {}, researched, userEvidence = [], estimate, lineage = null } = {}) {
  const openConcerns = comments.filter(comment => ['concern', 'alternative'].includes(comment.kind) && !comment.erased)
    .map(comment => ({ author: comment.actor, text: comment.comment }));
  const included = new Set(credits.map(credit => credit.comment));
  const acceptedCredits = credits.map(credit => {
    const comment = comments.find(entry => entry.body_hash === credit.comment);
    return { ...credit, author: comment?.actor || 'unknown', text: comment?.comment || '[erased or unavailable]' };
  });
  return {
    v: 2,
    original,
    see,
    spec,
    credits: acceptedCredits,
    userEvidence,
    openConcerns,
    unincludedComments: comments.filter(comment => !comment.erased && !included.has(comment.body_hash)).length,
    researched: researched || Object.fromEntries(RESEARCH_SOURCES.map(source => [source, { status: 'not connected', finding: 'nothing checked' }])),
    estimate: estimate || 'No estimate',
    lineage,
    worstCaseSpendMicros: Number.isSafeInteger(gatewayPolicy.worstCaseSpendMicros) && gatewayPolicy.worstCaseSpendMicros >= 0
      ? gatewayPolicy.worstCaseSpendMicros : null,
    spendEstimateStatus: Number.isSafeInteger(gatewayPolicy.worstCaseSpendMicros) && gatewayPolicy.worstCaseSpendMicros >= 0
      ? 'operator supplied; not independently verified' : 'unknown; no priced build plan supplied',
    sandboxLimits,
    doNothing: 'Do nothing / use what we have',
    specHash: spec.hash,
  };
}
