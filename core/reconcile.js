// Collaboration-first fork policy (owner decision, Nov 15 2026).
//
// A fork exists for a real, unresolved disagreement, not for silence. This is
// a pure projection over an item's events and stage posts: it adds no event
// type, so replay, imports and legacy hashes are untouched. Enforcement lives
// at the HTTP fork route; forks already in history stay valid.
//
// Owner (Nov 16): keep it simple. The disagreer may fork when the steward moves
// on, lets the window pass, or explicitly declines. No judging of reasons; the
// people decide whether it is worth joining and the leader decides whether a
// second experimental build is worth funding (a fork inherits no approval).
// Still undecided, so not invented: an unavailable-author path.
export const RECONCILE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const ALTERNATIVE = 'alternative';

// Stewardship and reconciliation use one clock. An active stage starts the
// inactivity clock if the steward has not written in that stage; otherwise the
// steward's latest active-stage event resets it. This pure projection keeps
// HTTP, Store validation, replay tooling, and tests aligned.
export function stewardInactivity(events, { steward = null, activePost = null, posts = [], now = Date.now() } = {}) {
  if (!steward || !activePost?.id) return { inactive: false, inactive_since: null, eligible_at: null };
  const active = posts.find(post => post.post_id === activePost.id && (post.closed_seq === null || post.closed_seq === undefined));
  const opened = active && events[active.opened_seq - 1];
  const onActiveStage = event => event.actor === steward && (event.post_id === activePost.id
    || activePost.id === `see:${event.body_hash}`);
  const last = events.filter(onActiveStage).at(-1) || opened;
  const since = Date.parse(last?.at);
  if (!Number.isFinite(since)) return { inactive: false, inactive_since: null, eligible_at: null };
  const eligibleAt = since + RECONCILE_DAYS * DAY_MS;
  return { inactive: now >= eligibleAt, inactive_since: new Date(since).toISOString(), eligible_at: new Date(eligibleAt).toISOString() };
}

const incorporatedHashes = events => new Set(events
  .filter(event => ['revised', 'specced'].includes(event.type))
  .flatMap(event => (event.credits || []).map(credit => credit.comment)));

export function reconciliation(events, { posts = [], steward = null, now = Date.now(), terminal = false } = {}) {
  const incorporated = incorporatedHashes(events);
  const closed = new Set(posts.filter(post => post.closed_seq !== null && post.closed_seq !== undefined).map(post => post.post_id));
  const declined = new Set(events.filter(event => event.type === 'commented' && event.kind === 'decline' && event.actor === steward
    && event.parent !== undefined).map(event => event.parent));
  const contributions = [];
  events.forEach((event, index) => {
    if (event.type !== 'commented' || event.kind !== ALTERNATIVE || event.erased) return;
    if (event.actor === steward) return;
    const age = now - Date.parse(event.at);
    const frozen = terminal || (event.post_id !== undefined && closed.has(event.post_id));
    const status = incorporated.has(event.body_hash) ? 'incorporated'
      : declined.has(event.body_hash) ? 'declined'
      : frozen ? 'unresolved_at_freeze'
      : age >= RECONCILE_DAYS * DAY_MS ? 'unresolved_after_window' : 'pending';
    contributions.push({ seq: index + 1, hash: event.body_hash, actor: event.actor, at: event.at, post_id: event.post_id ?? null,
      status, ...(status === 'pending' ? { fork_eligible_at: new Date(Date.parse(event.at) + RECONCILE_DAYS * DAY_MS).toISOString() } : {}) });
  });
  return { window_days: RECONCILE_DAYS, contributions };
}

const FORKABLE = new Set(['declined', 'unresolved_at_freeze', 'unresolved_after_window']);

// Decide whether `person` may fork. The disagreement is about the item, so any
// historical point of it may be the starting point. Returns { allowed, reason, ... }.
export function forkEligibility(report, { person, steward }) {
  if (person === steward) return { allowed: true, basis: 'steward of this branch' };
  const mine = report.contributions.filter(item => item.actor === person);
  const open = mine.filter(item => FORKABLE.has(item.status));
  if (open.length) return { allowed: true, basis: open[0].status, contribution: open[0].hash };
  const pending = mine.filter(item => item.status === 'pending').sort((a, b) => a.at.localeCompare(b.at))[0];
  if (pending) return { allowed: false, reason: 'your alternative is still in its reconciliation window; give the team time to agree',
    not_before: pending.fork_eligible_at };
  if (mine.some(item => item.status === 'incorporated')) return { allowed: false, reason: 'your alternative was incorporated, so there is no disagreement to fork over' };
  return { allowed: false, reason: 'a fork needs a disagreement: post an alternative in the active stage and give the team time to agree' };
}

// A transfer request is not a transfer. It is a visible request for a leader
// to consider, and needs both an aged unresolved alternative and an inactive
// current steward. No approval, spend, or tool authority changes here.
export function transferEligibility(report, inactivity, { person, steward }) {
  if (person === steward) return { allowed: false, reason: 'the current steward cannot request their own transfer' };
  const contribution = report.contributions.find(item => item.actor === person && item.status === 'unresolved_after_window');
  if (!contribution) return { allowed: false, reason: 'a transfer request needs your unresolved alternative after the reconciliation window' };
  if (!inactivity.inactive) return { allowed: false, reason: 'the current steward is still active in this stage', eligible_at: inactivity.eligible_at };
  return { allowed: true, contribution: contribution.hash, eligible_at: inactivity.eligible_at };
}
