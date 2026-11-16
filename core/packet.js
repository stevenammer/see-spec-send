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
  const ledger = spec.ledger || [];
  const version = spec.rules === 3 || ledger.length || spec.estimates?.length ? 3 : 2;
  return {
    v: version,
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
    ...(version === 3 ? {
      ledger,
      estimates: spec.estimates || [],
      openQuestions: ledger.filter(entry => entry.kind === 'question' && entry.status === 'open'),
      unverifiedAssumptions: ledger.filter(entry => entry.kind === 'assumption' && entry.status === 'unverified'),
    } : {}),
    worstCaseSpendMicros: Number.isSafeInteger(gatewayPolicy.worstCaseSpendMicros) && gatewayPolicy.worstCaseSpendMicros >= 0
      ? gatewayPolicy.worstCaseSpendMicros : null,
    spendEstimateStatus: Number.isSafeInteger(gatewayPolicy.worstCaseSpendMicros) && gatewayPolicy.worstCaseSpendMicros >= 0
      ? 'operator supplied; not independently verified' : 'unknown; no priced build plan supplied',
    sandboxLimits,
    doNothing: 'Do nothing / use what we have',
    specHash: spec.hash,
  };
}
