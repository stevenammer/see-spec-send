const open = new Set(['SEEN', 'CHECKED', 'SPECCED', 'SENDING', 'TRYING']);
const verdicts = new Set(['already_have', 'setting', 'free', 'pay', 'build_needed']);
export const initial = () => ({ phase: 'SEEN', steward: null, approver: null, specHash: null, cap: null, quorum: 2, spent: 0, artifact: null, helpers: [] });
const fail = refusal => ({ refusal });
const arr = x => Array.isArray(x);
const nonempty = x => typeof x === 'string' && x.length > 0;
const role = (e, r) => e.role === r;
const result = (c, effects = []) => ({ state: c.phase, effects, context: c });
const unchanged = (c, e) => ({ ...c, steward: e.type === 'steward_changed' ? e.steward : c.steward });
export function step(state, e) {
  const c = typeof state === 'string' ? { ...initial(), phase: state } : state;
  if (!e || typeof e !== 'object' || typeof e.type !== 'string') return fail('invalid event');
  if (!open.has(c.phase)) return fail('terminal state');
  const leaveSending = next => c.phase === 'SENDING' && next !== 'SENDING' ? [{ kind: 'build.stop', reason: e.type }] : [];
  if (['commented', 'erased'].includes(e.type) && role(e, 'member')) return result(unchanged(c, e));
  if (e.type === 'steward_changed' && role(e, 'leader') && nonempty(e.steward)) return result(unchanged(c, e));
  if (e.type === 'shelved' && ['leader', 'steward'].includes(e.role) && nonempty(e.reason)) return result({ ...c, phase: 'SHELVED' }, leaveSending('SHELVED'));
  if (e.type === 'checked' && c.phase === 'SEEN' && role(e, 'member') && arr(e.looked) && e.looked.length && arr(e.found) && verdicts.has(e.verdict)) {
    return result({ ...c, phase: e.verdict === 'already_have' ? 'SHELVED' : 'CHECKED' });
  }
  if (e.type === 'specced' && ['CHECKED', 'SPECCED', 'SENDING', 'TRYING'].includes(c.phase) && role(e, 'steward') && arr(e.must) && arr(e.out_of_scope) && arr(e.how_we_know) && e.how_we_know.length) {
    return result({ ...c, phase: 'SPECCED', steward: e.actor, specHash: e.body_hash || e.spec_hash || c.specHash, artifact: null, helpers: [] }, leaveSending('SPECCED'));
  }
  if (e.type === 'approved' && c.phase === 'SPECCED' && role(e, 'leader') && e.actor !== c.steward && nonempty(e.spec_hash) && e.spec_hash === c.specHash && Number.isFinite(e.cap_usd) && e.cap_usd >= 0 && Number.isInteger(e.quorum) && e.quorum >= 1) {
    return result({ ...c, phase: 'SENDING', approver: e.actor, cap: e.cap_usd, quorum: e.quorum, spent: 0 }, [{ kind: 'build.start', spec_hash: e.spec_hash, cap_usd: e.cap_usd }]);
  }
  if (e.type === 'returned' && c.phase === 'SPECCED' && role(e, 'leader') && nonempty(e.note)) return result({ ...c, phase: 'CHECKED' });
  if (e.type === 'charged' && c.phase === 'SENDING' && role(e, 'gateway')) {
    if (!Number.isFinite(e.usd) || e.usd < 0) return fail('invalid usd');
    if (c.spent + e.usd > c.cap) return fail('cap exceeded');
    return result({ ...c, spent: c.spent + e.usd });
  }
  if (e.type === 'tried' && c.phase === 'SENDING' && role(e, 'run') && nonempty(e.artifact_hash)) return result({ ...c, phase: 'TRYING', artifact: e.artifact_hash, helpers: [] }, leaveSending('TRYING'));
  if (e.type === 'failed' && ['SENDING', 'TRYING'].includes(c.phase) && role(e, 'run')) return result({ ...c, phase: 'SPECCED', artifact: null, helpers: [] }, leaveSending('SPECCED'));
  if (e.type === 'helped' && c.phase === 'TRYING' && role(e, 'member') && e.actor !== c.steward && e.actor !== c.approver && nonempty(e.artifact_hash) && e.artifact_hash === c.artifact) {
    const helpers = c.helpers.includes(e.actor) ? c.helpers : [...c.helpers, e.actor];
    return result({ ...c, helpers, phase: helpers.length >= c.quorum ? 'HELPS' : 'TRYING' });
  }
  return fail('event not allowed');
}
export function fold(events = []) {
  let c = initial(), effects = [];
  for (const e of events) { const r = step(c, e); if (r.refusal) return r; c = r.context; effects.push(...r.effects); }
  return { state: c.phase, effects, context: c };
}
