// Deterministic, deliberately plain decision packet. It describes unavailable
// research instead of pretending that a connector checked it.
export function buildPacket({ original, see, spec, credits = [], comments = [], gatewayPolicy = {}, sandboxLimits = {} }) {
  const openConcerns = comments.filter(comment => comment.kind === 'concern' && !comment.erased)
    .map(comment => ({ author: comment.actor, text: comment.comment }));
  const included = new Set(credits.map(credit => credit.comment));
  return {
    v: 1,
    original,
    see,
    spec,
    credits,
    openConcerns,
    unincludedComments: comments.filter(comment => !comment.erased && !included.has(comment.body_hash)).length,
    research: 'No source connected, nothing checked',
    estimate: 'No estimate',
    worstCaseSpendMicros: Number(gatewayPolicy.worstCaseSpendMicros || 0),
    sandboxLimits,
    doNothing: 'Do nothing / no build',
    specHash: spec.hash,
  };
}
