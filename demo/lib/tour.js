// The same sequence as docs/WATCH_IT_REFUSE.md, played through the demo's own log.
import { perform, summary } from './flow.js';
import { nameOf } from './roster.js';

export const tourSteps = [
  { who: 'maya', label: 'post a problem', action: 'post', expect: 'accepted',
    input: { problem: 'We copy every refund into a spreadsheet by hand.', verdict: 'build_needed',
      checks: { have: { on: true, note: 'Checked the billing tool settings.' } } },
    note: 'Maya posts a problem and says what she checked first.' },
  { who: 'maya', label: 'write the spec', action: 'spec', expect: 'accepted',
    input: { must: 'Show each refund once', how_we_know: 'Nobody opens the spreadsheet', out_of_scope: '' },
    note: 'Maya is the steward, so she writes the spec.' },
  { who: 'lena', label: 'approve, cap $5, quorum 2', action: 'approve', expect: 'accepted',
    input: { cap: '5', quorum: '2' },
    note: "Lena is a leader who didn't write the spec. She sets a $5 cap and needs 2 people." },
  { who: 'maya', label: 'deliver one try (a note here, playable in the real app)', action: 'deliver', expect: 'accepted',
    input: { text: 'One page that lists each refund once.' },
    note: 'Maya delivers one small try.' },
  { who: 'maya', label: 'say it helps (she wrote the spec)', action: 'help', expect: 'refused',
    note: 'The author tries to say it helps.' },
  { who: 'lena', label: 'say it helps (she approved it)', action: 'help', expect: 'refused',
    note: 'The leader who approved tries to say it helps.' },
  { who: 'maya', label: 'make up a "done" event', action: 'done', expect: 'refused',
    note: 'Someone tries to mark it done.' },
  { who: 'ben', label: 'say it helps', action: 'help', expect: 'accepted',
    note: "Ben didn't shape it, so his counts." },
  { who: 'cleo', label: 'say it helps', action: 'help', expect: 'accepted',
    note: 'Cleo is the second person. The quorum of 2 is met.' },
];

const progress = state => (state.state === 'TRYING' && state.approved
  ? ` (${state.helpers} of ${state.quorum} helpers)` : '');

// Plays one step and returns what happened, in the same shape the screen and the tests read.
export async function playStep(session, index) {
  const step = tourSteps[index];
  const outcome = await perform(session, step.who, step.action, step.input);
  const state = summary(session);
  return { index, step, outcome, state,
    line: `${step.who.padEnd(5)} ${step.label.padEnd(44)} ${outcome.status.padEnd(8)} item is ${state.state}${progress(state)}`,
    title: `${nameOf(step.who)}: ${step.label}` };
}

export async function playAll(session) {
  const played = [];
  for (let index = 0; index < tourSteps.length; index += 1) played.push(await playStep(session, index));
  return played;
}
