import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { validScope, withinScope } from '../core/scope.js';

function setup(t) {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('op'); store.registerPerson('member'); store.registerPerson('leader', { leader: true });
  let n = 0;
  const append = (item, event) => store.append(item, { ...event, at: new Date(Date.UTC(2026, 10, 15, 0, 0, ++n)).toISOString() }, { idem: `forks:${n}` });
  append('z-parent', { type: 'posted', actor: 'op', rules: 2, original: 'The first transfer problem.' });
  const see1 = store.events('z-parent')[0].body_hash;
  append('z-parent', { type: 'specced', actor: 'op', see_hash: see1, must: ['First note layout'], how_we_know: ['Notes survive'], out_of_scope: [], scope: { data_sources: ['synthetic-notes'], audiences: ['test-team'] } });
  const spec1 = store.events('z-parent').at(-1).body_hash;
  append('z-parent', { type: 'revised', actor: 'op', base_hash: see1, text: 'The newer transfer problem.' });
  const see2 = store.read('z-parent').context.seeHash;
  append('z-parent', { type: 'specced', actor: 'op', see_hash: see2, must: ['Second note layout'], how_we_know: ['Notes survive'], out_of_scope: [], scope: { data_sources: ['synthetic-notes'], audiences: ['test-team'] } });
  const spec2 = store.events('z-parent').at(-1).body_hash;
  const fork = (child, from) => append(child, { type: 'forked', actor: 'member', rules: 2, reason: 'Try a smaller alternative.', ...store.forkPoint('z-parent', from), from });
  return { store, append, fork, see1, see2, spec1, spec2 };
}

test('F4 a historical spec fork copies that point only as a draft, never authority', t => {
  const { store, fork, spec1 } = setup(t);
  fork('a-child', { kind: 'spec', hash: spec1 });
  const first = store.events('a-child')[0], state = store.read('a-child');
  assert.equal(first.original, 'The first transfer problem.');
  assert.deepEqual(first.seed_spec.must, ['First note layout']);
  assert.equal(state.state, 'SEEN'); assert.equal(state.context.steward, 'member');
  for (const key of ['specHash', 'artifact']) assert.equal(state.context[key], null);
  for (const key of ['sent', 'decided', 'leash']) assert.equal(state.context[key], undefined);
  assert.equal(state.context.approval, 0); assert.equal(state.context.spentMicros, 0); assert.deepEqual(state.context.helpers, []);
  assert.equal(store.db.prepare('SELECT parent_seq FROM lineage WHERE child=?').get('a-child').parent_seq, 2);
  assert.deepEqual(store.verifyAll().filter(result => !result.ok), []);
});

test('F4 forks survive export/import even when descendants sort before their parents', t => {
  const { store, append, fork, spec1 } = setup(t);
  fork('b-child', { kind: 'spec', hash: spec1 });
  const first = store.events('b-child')[0];
  append('a-grandchild', { type: 'forked', actor: 'op', rules: 2, reason: 'Try another direction.', ...store.forkPoint('b-child', { kind: 'see', hash: first.body_hash }), from: { kind: 'see', hash: first.body_hash } });
  const target = new Store(); t.after(() => target.close());
  target.importJsonl(store.exportJsonl());
  assert.deepEqual(target.verifyAll().filter(result => !result.ok), []);
  assert.equal(target.exportJsonl(), store.exportJsonl());
});

test('F4 terminal parents can be forked without reopening; selection cannot use unrelated or wrong-kind hashes', t => {
  const { store, append, fork, see1, spec1, spec2 } = setup(t);
  append('z-parent', { type: 'shelved', actor: 'op', reason: 'An existing view solves it.' });
  fork('a-child', { kind: 'see', hash: see1 });
  assert.equal(store.read('z-parent').state, 'SHELVED'); assert.equal(store.read('a-child').state, 'SEEN');
  assert.throws(() => store.forkPoint('z-parent', { kind: 'artifact', hash: spec1 }), /selection/);
  assert.throws(() => store.forkPoint('z-parent', { kind: 'spec', hash: 'a'.repeat(64) }), /selection/);
  const from = { kind: 'spec', hash: spec1 }, point = store.forkPoint('z-parent', from);
  assert.throws(() => append('wrong-hash', { type: 'forked', actor: 'member', rules: 2, ...point,
    from: { kind: 'spec', hash: spec2 } }), /selection does not match/);
  assert.throws(() => append('wrong-copy', { type: 'forked', actor: 'member', rules: 2, ...point, from, original: 'Invented parent claim.' }), /content must match/);
});

test('F4 selected erased spec text remains erased in child seed and survives replay', t => {
  const { store, fork, spec1 } = setup(t);
  store.erase('z-parent', spec1, 'op', '2026-11-15T00:00:05.000Z');
  fork('a-child', { kind: 'spec', hash: spec1 });
  assert.deepEqual(store.events('a-child')[0].seed_spec.must, ['[erased]']);
  assert.deepEqual(store.verifyAll().filter(result => !result.ok), []);
});

test('F4 later parent erasure does not prevent restoring an existing historical fork', t => {
  const { store, fork, spec1 } = setup(t);
  fork('a-child', { kind: 'spec', hash: spec1 });
  store.erase('z-parent', spec1, 'op', '2026-11-15T00:00:06.000Z');
  const restored = new Store(); t.after(() => restored.close());
  restored.importJsonl(store.exportJsonl());
  assert.deepEqual(restored.events('a-child')[0].seed_spec.must, ['First note layout']);
  assert.ok(restored.verifyAll().every(result => result.ok));
  fork('b-after-erasure', { kind: 'spec', hash: spec1 });
  assert.deepEqual(store.events('b-after-erasure')[0].seed_spec.must, ['[erased]']);
});

test('F4 an unselected new fork seed cannot invent a parent specification', t => {
  const { store, append } = setup(t);
  const point = store.forkPoint('z-parent');
  assert.throws(() => append('forged-seed', { type: 'forked', actor: 'member', rules: 2, ...point,
    seed_spec: { must: ['Invented'], how_we_know: ['Fake provenance'], out_of_scope: [] } }), /content must match/);
});

test('F4 lineage is verified against events and rebuild repairs missing, changed and orphan rows', t => {
  const { store, fork, spec1 } = setup(t); fork('a-child', { kind: 'spec', hash: spec1 });
  store.db.prepare('UPDATE lineage SET parent_seq=99 WHERE child=?').run('a-child');
  assert.equal(store.verifyAll().find(result => result.item === 'a-child').ok, false);
  store.rebuild(); assert.ok(store.verifyAll().every(result => result.ok));
  store.db.exec("DELETE FROM lineage"); assert.equal(store.verifyAll().find(result => result.item === 'a-child').ok, false);
  store.rebuild();
  store.db.prepare('INSERT INTO lineage VALUES(?,?,?,?,?,?)').run('orphan', 'z-parent', 1, 'x', null, null);
  assert.equal(store.verifyAll().find(result => result.item === 'orphan').ok, false);
  store.rebuild(); assert.ok(store.verifyAll().every(result => result.ok));
});

test('F4 typed scope permits only subsets and direct steers cannot add sources or audiences', t => {
  const { store, append, spec2 } = setup(t);
  const packet = store.putArtifact('z-parent', JSON.stringify({ specHash: spec2 }));
  append('z-parent', { type: 'sent', actor: 'op', spec_hash: spec2, packet_hash: packet });
  append('z-parent', { type: 'approved', actor: 'leader', spec_hash: spec2, packet_hash: packet, reason: 'A synthetic note view is within our scope.', cap_usd: 1, quorum: 1 });
  const steer = scope => append('z-parent', { type: 'steered', actor: 'op', approval: 1, spec_hash: spec2, instruction: 'Keep the note visible.', scope });
  assert.throws(() => steer({ data_sources: ['payroll'], audiences: ['test-team'] }), /scope expansion/);
  assert.throws(() => steer({ data_sources: ['synthetic-notes'], audiences: ['public'] }), /scope expansion/);
  steer({ data_sources: [], audiences: ['test-team'] });
  assert.equal(store.read('z-parent').context.iteration, 1);
  assert.equal(validScope({ data_sources: ['x', 'x'], audiences: [] }), false);
  assert.equal(withinScope({ data_sources: ['x'], audiences: [] }, { data_sources: ['x'], audiences: ['all'] }), false);
  assert.ok(store.verifyAll().every(result => result.ok));
  const target = new Store(); t.after(() => target.close()); target.importJsonl(store.exportJsonl());
  assert.ok(target.verifyAll().every(result => result.ok));
  assert.equal(target.artifact('z-parent', packet), store.artifact('z-parent', packet));
});
