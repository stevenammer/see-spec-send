// Exhaustive check of the core rule: try every sequence of events a small team, a gateway, a build run, an integration
// and an agent can produce, up to a depth, against the real core/machine.js, and check the rules on every state
// reached. Not a proof (it stops at a depth), but it covers every ordering of every event type for this cast, which
// a scenario test can't. See docs/RULE_CHECK.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { step, initial } from '../core/machine.js';

const PEOPLE = { ana: { kind: 'person' }, ben: { kind: 'person' }, cy: { kind: 'person' },
  lee: { kind: 'person', leader: true }, max: { kind: 'person', leader: true } };
const OTHERS = { gateway: { kind: 'gateway' }, run: { kind: 'run' }, feed: { kind: 'source' }, effort: { kind: 'agent' } };
const NAMES = Object.keys(PEOPLE);
const AT = '2026-11-28T12:00:00.000Z';
const REASON = 'a reason that is long enough';

// Every candidate event from this state, as [event, who]. Values are taken from the state, so the machine sees
// well-formed events; a few forgeries (stale artifact, wrong spec, wrong principal) are included on purpose.
function candidates(s) {
  const post = s.activePost ? { post_id: s.activePost.id, post_version: s.activePost.version } : {};
  const n = `${s.seeVersion || 0}.${s.specVersion || 0}.${s.approval}.${s.iteration ?? 0}`;
  const out = [];
  const add = (event, who) => out.push([{ at: AT, ...post, ...event }, who]);
  for (const actor of NAMES) {
    const who = PEOPLE[actor];
    add({ type: 'posted', actor, rules: 3, original: 'refunds get pasted twice', body_hash: `see-${actor}` }, who);
    add({ type: 'forked', actor, rules: 3, original: 'a fork', body_hash: `fork-${actor}`, parent: { item: 'x', seq: 9, hash: 'h' } }, who);
    add({ type: 'revised', actor, text: 'clearer', base_hash: s.seeHash, body_hash: `rev-${n}` }, who);
    add({ type: 'specced', actor, see_hash: s.seeHash, must: ['once'], out_of_scope: [], how_we_know: ['no dupes'], body_hash: `spec-${n}-${actor}` }, who);
    add({ type: 'sent', actor, spec_hash: s.specHash, packet_hash: `pk-${n}`, body_hash: `send-${n}` }, who);
    add({ type: 'approved', actor, spec_hash: s.sent?.specHash, packet_hash: s.sent?.packetHash, reason: REASON, cap_usd: 1, quorum: 2, body_hash: `ap-${n}` }, who);
    add({ type: 'approved', actor, spec_hash: 'forged-spec', packet_hash: s.sent?.packetHash, reason: REASON, cap_usd: 1, quorum: 1, body_hash: `apf-${n}` }, who);
    add({ type: 'returned', actor, spec_hash: s.sent?.specHash, packet_hash: s.sent?.packetHash, reason: REASON, body_hash: `ret-${n}` }, who);
    add({ type: 'steered', actor, approval: s.approval, spec_hash: s.specHash, instruction: 'smaller', body_hash: `st-${n}` }, who);
    add({ type: 'helped', actor, artifact_hash: s.artifact }, who);
    add({ type: 'helped', actor, artifact_hash: 'stale-artifact' }, who);
    add({ type: 'experiment_not_helpful', actor, approval: s.approval, spec_hash: s.specHash, artifact_hash: s.artifact, reason: REASON, evidence_summary: 'x', evidence_limits: 'y', body_hash: `enh-${n}` }, who);
    add({ type: 'op_withdrew', actor, reason: 'not needed', body_hash: `wd-${n}` }, who);
    for (const target of NAMES) if (target !== actor) add({ type: 'steward_changed', actor, steward: target, reason: REASON }, who);
  }
  add({ type: 'charged', actor: 'gateway', approval: s.approval, spec_hash: s.specHash, usd: 0.6 }, OTHERS.gateway);
  add({ type: 'tried', actor: 'run', approval: s.approval, spec_hash: s.specHash, iteration: s.iteration, artifact_hash: `art-${n}` }, OTHERS.run);
  add({ type: 'tried', actor: 'run', approval: s.approval, spec_hash: s.specHash, iteration: s.iteration, artifact_hash: `artb-${n}`, delivered_by: 'cy' }, OTHERS.run);
  add({ type: 'failed', actor: 'run', approval: s.approval, spec_hash: s.specHash, iteration: s.iteration, body_hash: `fail-${n}` }, OTHERS.run);
  // Principals without person authority trying person moves.
  for (const [name, who] of Object.entries(OTHERS)) {
    add({ type: 'approved', actor: name, spec_hash: s.sent?.specHash, packet_hash: s.sent?.packetHash, reason: REASON, cap_usd: 1, quorum: 1, body_hash: `apo-${n}` }, who);
    add({ type: 'helped', actor: name, artifact_hash: s.artifact }, who);
    add({ type: 'steward_changed', actor: name, steward: name, reason: REASON }, who);
  }
  add({ type: 'seen', actor: 'feed', problem: 'a reported problem', source_label: 'feed', honesty_label: 'documented' }, OTHERS.feed);
  return out;
}

// The rules, checked on every accepted transition. Returns the broken rule's name, or null.
export function violation(before, event, who, outcome) {
  const s = outcome.context;
  const shapers = new Set([...(s.authors || []), s.approver, s.specAuthor].filter(Boolean));
  if (s.helpers.some(h => shapers.has(h))) return 'a person who shaped the work counted toward helps';
  if (s.helpers.some(h => s.ineligibleHelpers.includes(h))) return 'an ineligible person counted toward helps';
  if (s.helpers.some(h => !PEOPLE[h])) return 'a non-person counted toward helps';
  if (s.phase === 'HELPS' && before.phase !== 'HELPS' && event.type !== 'helped') return `reached HELPS through ${event.type}, not helped`;
  if (s.phase === 'HELPS' && s.helpers.length < s.quorum) return 'reached HELPS below quorum';
  if (s.phase === 'HELPS' && !s.artifact) return 'reached HELPS with no try';
  if (outcome.effects.some(e => e.kind === 'build.start')
      && !(event.type === 'approved' && who?.leader === true && who.kind === 'person' && !(before.authors || []).includes(event.actor)))
    return 'a build started without approval by a leader who is not an author';
  if (s.capMicros !== null && s.spentMicros > s.capMicros) return 'spent past the cap';
  if (before.steward !== s.steward && before.steward !== null && !(event.type === 'steward_changed' && who?.leader)) return 'steward changed without a leader';
  if (['HELPS', 'SHELVED'].includes(before.phase) && s.phase !== before.phase) return 'left a terminal state';
  if (event.type === 'forked' && (s.approver || s.approval !== 0)) return 'a fork inherited an approval';
  return null;
}

export function explore(stepFn, depth) {
  const seen = new Set(); let frontier = [initial()]; let transitions = 0; let accepted = 0;
  const types = new Set();
  for (let d = 0; d < depth; d += 1) {
    const next = [];
    for (const s of frontier) {
      for (const [event, who] of candidates(s)) {
        transitions += 1;
        const outcome = stepFn(s, event, who);
        if (outcome.refusal) continue;
        accepted += 1; types.add(event.type);
        const broken = violation(s, event, who, outcome);
        if (broken) return { broken, from: s, event, who, transitions };
        const key = JSON.stringify(outcome.context);
        if (!seen.has(key)) { seen.add(key); next.push(outcome.context); }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { broken: null, states: seen.size, transitions, accepted, types: [...types].sort(), phases: [...new Set([...seen].map(k => JSON.parse(k).phase))].sort() };
}

const DEPTH = Number(process.env.RULE_CHECK_DEPTH || 8);

test(`no reachable sequence of up to ${DEPTH} events breaks the core rules`, () => {
  const r = explore(step, DEPTH);
  assert.equal(r.broken, null, r.broken && `${r.broken}\nevent: ${JSON.stringify(r.event)}\nby: ${JSON.stringify(r.who)}`);
  // The search really reached the whole lifecycle, so a pass means something.
  for (const phase of ['SEEN', 'SPECCED', 'SUBMITTED', 'SENDING', 'TRYING', 'HELPS', 'SHELVED']) assert.ok(r.phases.includes(phase), `never reached ${phase}`);
  for (const type of ['posted', 'forked', 'specced', 'sent', 'approved', 'charged', 'tried', 'helped', 'steward_changed', 'revised', 'steered', 'failed', 'returned'])
    assert.ok(r.types.includes(type), `never accepted ${type}`);
  console.log(`rule check: ${r.states} distinct states, ${r.transitions} transitions tried, ${r.accepted} accepted`);
});

test('the check catches a machine that forgets who shaped the work', () => {
  // Same machine, with the helper eligibility check removed: a spec author's "it helps" now counts.
  const broken = (s, e, who) => e.type === 'helped' && s.phase === 'TRYING'
    ? step({ ...s, ineligibleHelpers: [] }, e, who)
    : step(s, e, who);
  const r = explore(broken, DEPTH);
  assert.match(r.broken || '', /shaped the work|ineligible/);
});

test('the check catches a machine that lets a non-leader start a build', () => {
  const broken = (s, e, who) => e.type === 'approved' && who?.kind === 'person' ? step(s, e, { ...who, leader: true }) : step(s, e, who);
  assert.match(explore(broken, DEPTH).broken || '', /without approval by a leader/);
});

test('the check catches a machine that ignores the spending cap', () => {
  const broken = (s, e, who) => {
    if (e.type !== 'charged' || s.phase !== 'SENDING') return step(s, e, who);
    const o = step({ ...s, capMicros: Number.MAX_SAFE_INTEGER }, e, who);
    return o.refusal ? o : { ...o, context: { ...o.context, capMicros: s.capMicros } };
  };
  assert.match(explore(broken, DEPTH).broken || '', /cap/);
});
