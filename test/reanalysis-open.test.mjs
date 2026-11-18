import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { runReanalysis } from '../reanalysis/run.js';

const stamp = '2026-11-10T12:00:00.000Z', later = '2026-11-16T12:00:00.000Z';
let n = 0;

// Dana's SPEC is still open and rests on an assumption. Sam's case later reaches a decision that bears on it.
function world(t, { danaOpen = true } = {}) {
  const s = new Store(); t.after(() => s.close());
  for (const id of ['dana', 'sam']) s.registerPerson(id);
  s.registerPerson('lee', { leader: true });
  const add = (item, event) => s.append(item, { ...event, at: stamp }, { idem: `op-${++n}` });
  const bind = item => ({ post_id: s.read(item).context.activePost?.id, post_version: s.read(item).context.activePost?.version });
  const item = (name, author, original, assumption) => {
    add(name, { type: 'posted', actor: author, original, rules: 3 });
    add(name, { type: 'specced', actor: author, see_hash: s.read(name).context.seeHash, must: ['Keep the caller note'], how_we_know: ['The note appears'], out_of_scope: [], assumptions: [assumption], open_questions: [], ...bind(name) });
  };
  item('dana', 'dana', 'The handoff loses the caller note.', 'The handoff needs a new integration to carry the caller note.');
  item('sam', 'sam', 'Night shift cannot see the export.', 'The export permission is the only blocker.');
  const spec = s.read('sam').context.specHash, packet = s.putArtifact('sam', JSON.stringify({ specHash: spec }));
  add('sam', { type: 'sent', actor: 'sam', spec_hash: spec, packet_hash: packet, ...bind('sam') });
  add('sam', { type: 'decided', actor: 'lee', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'The existing export already carries the caller note across the handoff, so no integration is needed.', metadata: { alternative: 'Use the export.', action_owner: 'sam' }, spec_hash: spec, packet_hash: packet, ...bind('sam') });
  const decide = (name, reason) => {
    item(name, 'sam', 'Another caller note handoff problem.', 'Some unrelated assumption about parking.');
    const sp = s.read(name).context.specHash, pk = s.putArtifact(name, JSON.stringify({ specHash: sp }));
    add(name, { type: 'sent', actor: 'sam', spec_hash: sp, packet_hash: pk, ...bind(name) });
    add(name, { type: 'decided', actor: 'lee', disposition: 'resolve_without_build', reason_code: 'existing', reason, metadata: { alternative: 'Use it.', action_owner: 'sam' }, spec_hash: sp, packet_hash: pk, ...bind(name) });
  };
  return { s, add, bind, decide };
}
const state = (s, item) => JSON.stringify({ ...s.read(item).context, activePost: undefined });

test('a result that bears on an open SPEC puts one labeled AI comment in the live thread and changes nothing else', t => {
  const { s } = world(t);
  const before = { events: s.eventRows('dana').length, state: state(s, 'dana'), spec: s.read('dana').context.specHash };
  const out = runReanalysis(s, { now: later });
  assert.equal(out.openThreads.length, 1);
  const comment = s.events('dana').at(-1);
  assert.equal(comment.type, 'commented'); assert.equal(comment.actor, 'effort'); assert.equal(comment.kind, 'agent');
  assert.match(comment.comment, /Found by Effort \(AI\)/); assert.match(comment.comment, /new integration to carry the caller note/);
  assert.match(comment.comment, /does not change the spec or any decision/);
  assert.equal(comment.anchor_kind, 'spec'); assert.equal(comment.anchor_hash, before.spec);
  assert.equal(s.eventRows('dana').length, before.events + 1, 'exactly one event was added');
  assert.equal(state(s, 'dana'), before.state, 'steward, approval, phase and spec are untouched');
  assert.equal(s.read('dana').context.specHash, before.spec);
  assert.equal(s.knowledge.entries('annex').filter(row => row.body.parent.item === 'dana').length, 0, 'an open thread gets a comment, not a frozen-case annex');
  assert.ok(s.verify('dana').ok);
});

test('rerunning, and a second matching result inside a week, add nothing; the AI comment is never a delta', t => {
  const { s, decide } = world(t);
  runReanalysis(s, { now: later });
  const count = s.eventRows('dana').length;
  assert.equal(runReanalysis(s, { now: later }).openThreads.length, 0);
  assert.equal(runReanalysis(s, { now: '2026-11-18T12:00:00.000Z' }).deltas.filter(d => d.source.item === 'dana').length, 0, 'the AI comment did not become a delta');
  assert.equal(s.eventRows('dana').length, count);
  // A different result a day later still waits out the weekly limit for this thread.
  decide('kim', 'The same existing export already carries the caller note across the handoff, so no integration is needed either.');
  runReanalysis(s, { now: '2026-11-17T12:00:00.000Z' });
  assert.equal(s.eventRows('dana').length, count, 'at most one comment a week per thread');
  assert.ok(s.eventRows('dana').length <= count + 1, 'after the week a new result may add at most one more');
});

test('a read-gated case gets no comment', t => {
  const { s } = world(t);
  const quiet = runReanalysis(s, { now: later, canRead: (_viewer, scope) => scope.id !== 'dana' });
  assert.equal(quiet.openThreads.length, 0, 'no read access means no comment');
  assert.equal(s.events('dana').filter(e => e.actor === 'effort').length, 0);
});

test('the comment is attributed to Effort as an agent, so a person cannot be mistaken for the author and no person is credited', t => {
  const { s } = world(t);
  runReanalysis(s, { now: later });
  const comment = s.events('dana').at(-1);
  assert.equal(s.authorityFromRow(s.eventRows('dana').at(-1)).kind, 'agent');
  assert.ok(!('person' in comment));
  assert.equal(s.read('dana').context.steward, 'dana');
});

test('an open thread that shares fewer than three terms with the result gets no comment', t => {
  const { s, decide } = world(t);
  // A rewrite of the result that shares only "integration" with Dana's assumption.
  s.db.exec("DELETE FROM reanalysis_pairs");
  decide('jose', 'Parking validation integration is out of scope.');
  const out = runReanalysis(s, { now: later });
  const danaComments = s.events('dana').filter(event => event.actor === 'effort');
  assert.ok(danaComments.every(event => !/Parking validation/.test(event.comment)), 'a one-word overlap is never enough');
  assert.ok(out.openThreads.every(row => row.item !== 'jose'));
});

test('a restricted result never reaches an open thread whose readers cannot all read it', t => {
  const s = new Store(); t.after(() => s.close());
  for (const id of ['dana', 'sam', 'pat']) s.registerPerson(id); s.registerPerson('lee', { leader: true });
  s.groupCreate('Reservations'); s.groupAdd('Reservations', 'sam'); s.groupAdd('Reservations', 'lee'); s.groupAdd('Reservations', 'dana'); // Dana (the steward) can read it; the thread's other readers cannot
  let n = 0; const add = (item, event) => s.append(item, { ...event, at: stamp }, { idem: `rs-${++n}` });
  const bind = item => ({ post_id: s.read(item).context.activePost?.id, post_version: s.read(item).context.activePost?.version });
  // Dana's thread is open to everyone; Sam's result is restricted to Reservations, which includes Dana but not Pat.
  add('dana', { type: 'posted', actor: 'dana', original: 'The handoff loses the caller note.', rules: 3 });
  add('dana', { type: 'specced', actor: 'dana', see_hash: s.read('dana').context.seeHash, must: ['Keep note'], how_we_know: ['It appears'], out_of_scope: [], assumptions: ['The handoff needs a new integration to carry the caller note.'], open_questions: [], ...bind('dana') });
  add('sam', { type: 'posted', actor: 'sam', original: 'Night shift export problem.', rules: 3, audience: ['Reservations'] });
  add('sam', { type: 'specced', actor: 'sam', see_hash: s.read('sam').context.seeHash, must: ['Fix'], how_we_know: ['Works'], out_of_scope: [], assumptions: ['x marks the spot'], open_questions: [], ...bind('sam') });
  const spec = s.read('sam').context.specHash, packet = s.putArtifact('sam', JSON.stringify({ specHash: spec }));
  add('sam', { type: 'sent', actor: 'sam', spec_hash: spec, packet_hash: packet, ...bind('sam') });
  add('sam', { type: 'decided', actor: 'lee', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'The existing export already carries the caller note across the handoff, so no integration is needed.', metadata: { alternative: 'Use the export.', action_owner: 'sam' }, spec_hash: spec, packet_hash: packet, ...bind('sam') });
  const out = runReanalysis(s, { now: later });
  assert.equal(out.openThreads.length, 0, 'a thread open to everyone cannot receive text from a restricted case');
  assert.equal(s.events('dana').filter(e => e.actor === 'effort').length, 0);
});
