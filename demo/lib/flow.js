// Turns what a visitor types into machine events, and reports what the machine said.
// Input is checked and bounded here. Nothing here decides who may do what:
// that is the machine's job, working from the roster.
import { explain } from './rules.js';
import { runToken } from './roster.js';

export const limits = { problem: 500, note: 280, line: 200, lines: 8, text: 1000, reason: 200, quorumMax: 6, steps: 200 };
export const checkKinds = ['have', 'pay_for', 'free', 'setting'];
export const verdicts = ['build_needed', 'already_have', 'setting', 'free', 'pay'];
export const stageLabels = {
  SEEN: 'See', CHECKED: 'Checked', SPECCED: 'Spec', SENDING: 'Send', TRYING: 'Send', HELPS: 'Helps', SHELVED: 'Shelved',
};

// Keeps saved try text only when it still matches the hash the chain recorded for it.
export async function restoreArtifacts(log, saved) {
  const kept = new Map();
  if (!Array.isArray(saved)) return kept;
  for (const entry of saved.slice(0, limits.steps)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
    if (entry[1].length <= limits.text && await log.hashArtifact(entry[1]) === entry[0]) kept.set(entry[0], entry[1]);
  }
  return kept;
}

export function createSession({ log, roster }) {
  return { log, roster, attempts: 0, refusals: [], artifacts: new Map() };
}

const text = (value, max, name) => {
  const clean = String(value ?? '').trim();
  if (!clean) return { error: `${name} can't be empty.` };
  if (clean.length > max) return { error: `${name} has to be ${max} characters or fewer.` };
  return { value: clean };
};

export function parseLines(value, { name, required = true } = {}) {
  const lines = String(value ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  if (required && !lines.length) return { error: `${name} needs at least one line.` };
  if (lines.length > limits.lines) return { error: `${name} can have at most ${limits.lines} lines.` };
  if (lines.some(line => line.length > limits.line)) return { error: `Each line in ${name} has to be ${limits.line} characters or fewer.` };
  return { value: lines };
}

export function parseCap(value) {
  const clean = String(value ?? '').trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(clean)) return { error: 'The cap is dollars, like 5 or 2.50, up to 9999.99.' };
  return { value: Number(clean) };
}

export function parseQuorum(value) {
  const clean = String(value ?? '').trim();
  if (!/^\d{1,2}$/.test(clean) || Number(clean) < 1 || Number(clean) > limits.quorumMax) {
    return { error: `The number of people who must say it helps is 1 to ${limits.quorumMax}.` };
  }
  return { value: Number(clean) };
}

// Each builder returns { event } (without actor, at) or { error } when the form is not usable.
const builders = {
  post(input) {
    const problem = text(input.problem, limits.problem, 'The problem');
    if (problem.error) return problem;
    if (!verdicts.includes(input.verdict)) return { error: 'Pick what you found.' };
    const looked = [];
    for (const kind of checkKinds) {
      if (!input.checks?.[kind]?.on) continue;
      const note = String(input.checks[kind].note ?? '').slice(0, limits.note);
      looked.push(`${kind}:${note}`);
    }
    if (!looked.length) return { error: 'Tick at least one thing you checked first.' };
    return { event: { type: 'checked', problem: problem.value, looked, found: [], verdict: input.verdict } };
  },
  spec(input) {
    const must = parseLines(input.must, { name: 'What it must do' });
    if (must.error) return must;
    const how = parseLines(input.how_we_know, { name: "How we'll know" });
    if (how.error) return how;
    const out = parseLines(input.out_of_scope, { name: 'Out of scope', required: false });
    if (out.error) return out;
    return { event: { type: 'specced', must: must.value, how_we_know: how.value, out_of_scope: out.value } };
  },
  approve(input, session) {
    const cap = parseCap(input.cap);
    if (cap.error) return cap;
    const quorum = parseQuorum(input.quorum);
    if (quorum.error) return quorum;
    // Like the real server, the approval is bound to whatever spec is current.
    return { event: { type: 'approved', cap_usd: cap.value, quorum: quorum.value,
      spec_hash: session.log.replay().context.specHash } };
  },
  help() { return { event: { type: 'helped' } }; },
  done() { return { event: { type: 'done' } }; },
  shelve(input) {
    const reason = text(input.reason, limits.reason, 'The reason');
    if (reason.error) return reason;
    return { event: { type: 'shelved', reason: reason.value } };
  },
};

export const actionNames = ['post', 'spec', 'approve', 'deliver', 'help', 'done', 'shelve'];

// Runs one action as one person. Returns one of:
//   { status: 'invalid', message }            the form was not usable, nothing was tried
//   { status: 'accepted', event, state }      the machine accepted it and the log grew
//   { status: 'refused', rule, words, state } the machine refused it, the log is unchanged
export async function perform(session, who, action, input = {}) {
  if (!actionNames.includes(action)) return { status: 'invalid', message: 'Unknown action.' };
  if (session.log.length >= limits.steps) {
    return { status: 'invalid', message: `This session has ${limits.steps} steps. Press "Start over" to begin again.` };
  }
  const before = session.log.replay();
  const context = before.context;
  let event;
  if (action === 'deliver') {
    const note = text(input.text, limits.text, 'The try');
    if (note.error) return { status: 'invalid', message: note.error };
    const authority = session.roster[who];
    // The web layer, not the machine, limits who may deliver. The real server does the same check.
    const allowed = authority?.leader === true || context.steward === who;
    if (before.state !== 'SENDING' || !allowed) {
      return refusal(session, who, action, 'deliver-who', before.state, before.state !== 'SENDING'
        ? 'A try can only be delivered after a leader approves the spec. That check is in the web layer.'
        : 'Only the steward or a leader can deliver a try. That check is in the web layer, not the machine.');
    }
    const artifact = await session.log.hashArtifact(note.value);
    session.artifacts.set(artifact, note.value);
    event = { type: 'tried', actor: runToken, artifact_hash: artifact, approval: context.approval,
      spec_hash: context.specHash, delivered_by: who };
  } else {
    const built = builders[action](input, session);
    if (built.error) return { status: 'invalid', message: built.error };
    event = { ...built.event, actor: who };
    if (action === 'help') event.artifact_hash = context.artifact ?? 'no-try-yet';
  }
  session.attempts += 1;
  const outcome = await session.log.append({ ...event, at: session.log.now() }, { idem: `attempt-${session.attempts}` });
  if (outcome.ok) return { status: 'accepted', event, state: outcome.state, context: outcome.context };
  const authority = session.roster[event.actor];
  const why = outcome.refused
    ? explain(context, event, authority, outcome.error)
    : { rule: 'not-allowed', words: outcome.error };
  return refusal(session, who, action, why.rule, before.state, why.words, outcome.error);
}

function refusal(session, who, action, rule, state, words, machine = 'refused by the web layer') {
  const entry = { status: 'refused', who, action, rule, words, state, machine };
  session.refusals.push(entry);
  return entry;
}

// What the screen shows about the item, in one object.
export function summary(session) {
  const replay = session.log.replay();
  const context = replay.context;
  return {
    state: replay.state,
    stage: stageLabels[replay.state],
    steward: context.steward,
    approver: context.approver,
    capUsd: context.capMicros === null ? null : context.capMicros / 1_000_000,
    quorum: context.quorum,
    helpers: context.helpers.length,
    approved: context.approval > 0,
    artifact: context.artifact,
    artifactText: context.artifact ? session.artifacts.get(context.artifact) ?? null : null,
    done: replay.state === 'HELPS' || replay.state === 'SHELVED',
  };
}
