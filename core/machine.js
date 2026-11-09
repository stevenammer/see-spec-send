const open = new Set(['SEEN', 'CHECKED', 'SPECCED', 'SENDING', 'TRYING']);
const verdicts = new Set(['already_have', 'setting', 'free', 'pay', 'build_needed']);

export const initial = () => ({
  phase: 'SEEN', steward: null, approver: null, specHash: null,
  cap: null, quorum: 2, spent: 0, artifact: null, helpers: [],
});

const fail = refusal => ({ refusal });
const nonempty = value => typeof value === 'string' && value.length > 0;
const array = value => Array.isArray(value);
const result = (context, effects = []) => ({ state: context.phase, context, effects });
const person = who => who?.kind === 'person';
const leader = who => person(who) && who.leader === true;
const steward = (state, event, who) => person(who) && event.actor === state.steward;

function stopsBuild(state, next, reason) {
  return state.phase === 'SENDING' && next !== 'SENDING'
    ? [{ kind: 'build.stop', reason }]
    : [];
}

function validSpec(event) {
  return array(event.must) && array(event.out_of_scope)
    && array(event.how_we_know) && event.how_we_know.length > 0;
}

// Authority is separate so event data cannot grant it.
export function step(state, event, who) {
  const context = typeof state === 'string' ? { ...initial(), phase: state } : state;
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return fail('invalid event');
  if (!open.has(context.phase)) return fail('terminal state');

  if (event.type === 'commented' && person(who)) return result(context);
  if (event.type === 'erased' && (leader(who) || steward(context, event, who))) return result(context);
  if (event.type === 'steward_changed' && leader(who) && nonempty(event.steward)) {
    return result({ ...context, steward: event.steward });
  }
  if (event.type === 'shelved' && nonempty(event.reason)
      && (leader(who) || steward(context, event, who))) {
    return result({ ...context, phase: 'SHELVED' }, stopsBuild(context, 'SHELVED', event.type));
  }
  if (event.type === 'checked' && context.phase === 'SEEN' && person(who)
      && array(event.looked) && event.looked.length > 0 && array(event.found)
      && verdicts.has(event.verdict)) {
    const phase = event.verdict === 'already_have' ? 'SHELVED' : 'CHECKED';
    return result({ ...context, phase, steward: event.actor });
  }
  if (event.type === 'specced'
      && ['CHECKED', 'SPECCED', 'SENDING', 'TRYING'].includes(context.phase)
      && steward(context, event, who) && validSpec(event)) {
    return result({ ...context, phase: 'SPECCED', specHash: event.body_hash || event.spec_hash,
      artifact: null, helpers: [] }, stopsBuild(context, 'SPECCED', event.type));
  }
  if (event.type === 'approved' && context.phase === 'SPECCED' && leader(who)
      && event.actor !== context.steward && nonempty(event.spec_hash)
      && event.spec_hash === context.specHash && Number.isFinite(event.cap_usd)
      && event.cap_usd >= 0 && Number.isInteger(event.quorum) && event.quorum >= 1) {
    const next = { ...context, phase: 'SENDING', approver: event.actor,
      cap: event.cap_usd, quorum: event.quorum, spent: 0 };
    return result(next, [{ kind: 'build.start', spec_hash: event.spec_hash, cap_usd: event.cap_usd }]);
  }
  if (event.type === 'returned' && context.phase === 'SPECCED' && leader(who)
      && nonempty(event.note)) return result({ ...context, phase: 'CHECKED' });
  if (event.type === 'charged' && context.phase === 'SENDING' && who?.kind === 'gateway') {
    if (!Number.isFinite(event.usd) || event.usd < 0) return fail('invalid usd');
    if (context.spent + event.usd > context.cap) return fail('cap exceeded');
    return result({ ...context, spent: context.spent + event.usd });
  }
  if (event.type === 'tried' && context.phase === 'SENDING' && who?.kind === 'run'
      && nonempty(event.artifact_hash)) {
    return result({ ...context, phase: 'TRYING', artifact: event.artifact_hash, helpers: [] },
      stopsBuild(context, 'TRYING', event.type));
  }
  if (event.type === 'failed' && ['SENDING', 'TRYING'].includes(context.phase) && who?.kind === 'run') {
    return result({ ...context, phase: 'SPECCED', artifact: null, helpers: [] },
      stopsBuild(context, 'SPECCED', event.type));
  }
  if (event.type === 'helped' && context.phase === 'TRYING' && person(who)
      && event.actor !== context.steward && event.actor !== context.approver
      && nonempty(event.artifact_hash) && event.artifact_hash === context.artifact) {
    const helpers = context.helpers.includes(event.actor) ? context.helpers : [...context.helpers, event.actor];
    return result({ ...context, helpers, phase: helpers.length >= context.quorum ? 'HELPS' : 'TRYING' });
  }
  return fail('event not allowed');
}

export function fold(events = [], resolve = () => undefined) {
  let context = initial();
  let effects = [];
  for (const event of events) {
    const outcome = step(context, event, resolve(event.actor));
    if (outcome.refusal) return outcome;
    context = outcome.context;
    effects = effects.concat(outcome.effects);
  }
  return { state: context.phase, context, effects };
}
