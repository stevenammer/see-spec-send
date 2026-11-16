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
