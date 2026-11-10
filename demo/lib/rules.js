// Explains a refusal in plain words. The machine only says "event not allowed";
// this works out which rule fired, from the same state and the same authority the machine saw.
// It never decides anything. It only describes a decision the machine already made.
import { nameOf } from './roster.js';

const known = new Set(['checked', 'specced', 'approved', 'returned', 'charged', 'tried', 'failed',
  'helped', 'shelved', 'commented', 'steward_changed', 'erased']);
const shortText = value => String(value ?? '').slice(0, 40);

export const rules = {
  'no-done-event': 'There is no "done" event. Nothing marks an item finished by hand.',
  'unknown-event': 'The machine has no event with that name.',
  finished: 'This item already reached Helps or was shelved. Those end the item.',
  'no-try-yet': 'There is no try to confirm yet. "It helps" only counts on a delivered try.',
  'approver-cannot-help': 'The leader who approved it cannot say it helps.',
  'author-cannot-help': 'The person who wrote the spec cannot say it helps.',
  'past-shaper-cannot-help': 'Anyone who has been steward, written a spec, or approved it cannot say it helps.',
  'stale-artifact': 'That "it helps" is for an older try. Only the current try counts.',
  'wrong-stage': 'The item is not at the right stage for that.',
  'leaders-approve': 'Only a leader can approve.',
  'steward-cannot-approve': 'A leader who is also the steward cannot approve their own spec.',
  'stale-spec': 'That approval is for a spec that is not the current one.',
  'bad-budget': 'The cap and quorum have to be real numbers. The cap is money, the quorum is at least one person.',
  'only-steward-specs': 'Only the steward can write or change the spec.',
  'bad-spec': 'A spec needs a list of what it must do, an out-of-scope list, and at least one way to know it worked.',
  'already-posted': 'This problem is already posted. Start over to post a new one.',
  'bad-check': 'Posting needs a problem, at least one thing you checked, and what you found.',
  'shelve-needs-leader-or-steward': 'Only a leader or the steward can shelve an item, and they need a reason.',
  'stale-approval': 'That build event belongs to an older approval. A new approval starts a new build.',
  'wrong-actor': 'Only the build run and cost gateway can send that kind of event.',
  'not-allowed': 'The machine does not allow that event right now.',
};

const result = (rule, extra = '') => ({ rule, words: `${rules[rule]}${extra ? ` ${extra}` : ''}` });

export function explain(context, event, authority, refusal = 'event not allowed') {
  if (typeof event?.type !== 'string' || !event.type) return result('unknown-event');
  if (event.type === 'done') return result('no-done-event');
  if (!known.has(event.type)) return result('unknown-event', `(${shortText(event.type)})`);
  if (!['SEEN', 'CHECKED', 'SPECCED', 'SENDING', 'TRYING'].includes(context.phase)) return result('finished');
  const person = authority?.kind === 'person';
  const leader = person && authority.leader === true;
  const who = nameOf(event.actor);
  if (event.type === 'helped') {
    if (context.phase !== 'TRYING') return result('no-try-yet');
    if (context.ineligibleHelpers.includes(event.actor)) {
      if (event.actor === context.approver) return result('approver-cannot-help', `${who} approved it.`);
      if (event.actor === context.steward) return result('author-cannot-help', `${who} is the steward and wrote the spec.`);
      return result('past-shaper-cannot-help', `${who} has shaped this item.`);
    }
    if (event.artifact_hash !== context.artifact) return result('stale-artifact');
  }
  if (event.type === 'approved') {
    if (context.phase !== 'SPECCED') return result('wrong-stage', 'Approval comes after a spec and before a try.');
    if (!leader) return result('leaders-approve', `${who} is not a leader.`);
    if (event.actor === context.steward) return result('steward-cannot-approve', `${who} wrote this spec.`);
    if (event.spec_hash !== context.specHash) return result('stale-spec');
    return result('bad-budget');
  }
  if (event.type === 'specced') {
    if (!['CHECKED', 'SPECCED', 'SENDING', 'TRYING'].includes(context.phase)) {
      return result('wrong-stage', 'Post and check a problem first.');
    }
    if (!person || event.actor !== context.steward) return result('only-steward-specs', `${who} is not the steward.`);
    return result('bad-spec');
  }
  if (event.type === 'checked') {
    return context.phase === 'SEEN' ? result('bad-check') : result('already-posted');
  }
  if (event.type === 'shelved') return result('shelve-needs-leader-or-steward');
  if (['charged', 'tried', 'failed'].includes(event.type)) {
    if (!['run', 'gateway'].includes(authority?.kind)) return result('wrong-actor');
    if (/approval|spec hash/.test(refusal)) return result('stale-approval');
  }
  return result('not-allowed');
}
