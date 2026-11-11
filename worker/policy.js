// Policy is data so an external adapter has one narrow, reviewable contract.
export const defaultBuilderPolicy = Object.freeze({
  egress: Object.freeze([]),
  filesystem: Object.freeze({ read: Object.freeze(['spec']), write: Object.freeze(['artifact']) }),
  limits: Object.freeze({ cpu_ms: 30_000, memory_mb: 512, wall_ms: 60_000 }),
});

export function validateBuilderPolicy(policy = defaultBuilderPolicy) {
  if (!Array.isArray(policy.egress) || policy.egress.length !== 0) throw Error('egress is denied by default');
  if (!Array.isArray(policy.filesystem?.read) || !Array.isArray(policy.filesystem?.write)) throw Error('filesystem scope required');
  for (const key of ['cpu_ms', 'memory_mb', 'wall_ms']) {
    if (!Number.isSafeInteger(policy.limits?.[key]) || policy.limits[key] <= 0) throw Error('resource limit required');
  }
  return policy;
}

export function enforceBuilderAttempt(policy, attempt, emergencyKill) {
  validateBuilderPolicy(policy);
  const denied = ['egress', 'host_mount', 'cross_run_read', 'raw_socket', 'over_time', 'over_memory'].includes(attempt.kind);
  if (!denied) return { allowed: true };
  emergencyKill(`builder policy violation: ${attempt.kind}`);
  return { allowed: false, killed: true, reason: 'builder policy violation' };
}
