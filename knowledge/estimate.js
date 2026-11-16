const validDimension = new Set(['build_spend', 'people_time', 'recurring_cost', 'calendar_time']);
const validBasis = new Set(['gateway_policy', 'prior_item', 'document', 'author_judgment']);

export function normalizeEstimates(value, prior = []) {
  if (value === undefined) return prior;
  return value.map(estimate => ({ ...estimate, basis: estimate.basis?.length ? estimate.basis : [{ kind: 'author_judgment', ref: 'No source recorded' }] }));
}

export function validEstimates(value) {
  return Array.isArray(value) && value.every(estimate => estimate && validDimension.has(estimate.dimension)
    && Number.isFinite(estimate.low) && Number.isFinite(estimate.high) && estimate.low >= 0 && estimate.high >= estimate.low
    && typeof estimate.unit === 'string' && estimate.unit.length > 0 && estimate.unit.length <= 120
    && Array.isArray(estimate.basis) && estimate.basis.length > 0
    && estimate.basis.every(basis => basis && validBasis.has(basis.kind) && typeof basis.ref === 'string' && basis.ref.length > 0 && basis.ref.length <= 2000)
    && Array.isArray(estimate.unknowns) && estimate.unknowns.every(value => typeof value === 'string' && value.length <= 2000)
    && Array.isArray(estimate.alternatives) && estimate.alternatives.every(value => typeof value === 'string' && value.length <= 2000));
}

export const gatewayRange = policy => Number.isSafeInteger(policy?.worstCaseSpendMicros) && policy.worstCaseSpendMicros >= 0
  ? { low: 0, high: policy.worstCaseSpendMicros, unit: 'micros', basis: [{ kind: 'gateway_policy', ref: 'gateway policy worst case' }] }
  : null;

export function priorChargedRange(receipts = []) {
  if (receipts.length < 3) return { status: 'too few prior builds', n: receipts.length };
  const charged = receipts.map(receipt => receipt.charged_micros ?? receipt.charged).filter(Number.isFinite);
  return { low: Math.min(...charged), high: Math.max(...charged), unit: 'micros', n: charged.length,
    basis: [{ kind: 'prior_item', ref: `${charged.length} prior charged totals` }] };
}
