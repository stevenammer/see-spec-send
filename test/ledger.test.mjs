import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { buildPacket } from '../core/packet.js';
import { buildCloseout } from '../core/closeout.js';

function setup(t, rules = 3) {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('steward'); store.registerPerson('coworker');
  let count = 0;
  const append = event => store.append('ledger', { ...event, at: new Date(1800000000000 + ++count * 1000).toISOString(),
    ...(rules === 3 && count > 1 ? { post_id: store.read('ledger').context.activePost?.id, post_version: store.read('ledger').context.activePost?.version } : {}) }, { idem: `ledger-${count}` });
  append({ type: 'posted', actor: 'steward', rules, original: 'Use synthetic records.' });
  return { store, append };
}

test('ledger entry keeps its id across spec revisions', t => {
  const { store, append } = setup(t); const see = store.read('ledger').context.seeHash;
  append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep records'], how_we_know: ['Read it'], out_of_scope: [], assumptions: ['The fixture remains available'], open_questions: ['Who reviews it?'] });
  const first = store.events('ledger').at(-1).ledger;
  append({ type: 'specced', actor: 'steward', see_hash: see, base_spec_hash: store.read('ledger').context.specHash, must: ['Keep records'], how_we_know: ['Read it'], out_of_scope: [], assumptions: ['The fixture remains available'], open_questions: ['Who reviews it?'] });
  assert.deepEqual(store.events('ledger').at(-1).ledger.map(entry => entry.id), first.map(entry => entry.id));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM ledger_entries WHERE item=?').get('ledger').n, 4);
});

test('comment resolves claim does not change status until steward revises', t => {
  const { store, append } = setup(t); const see = store.read('ledger').context.seeHash;
  append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep records'], how_we_know: ['Read it'], out_of_scope: [], assumptions: [], open_questions: ['Who reviews it?'] });
  const entry = store.events('ledger').at(-1).ledger[0];
  append({ type: 'commented', actor: 'coworker', kind: 'comment', comment: 'I can answer this.', anchor_kind: 'spec', anchor_hash: store.read('ledger').context.specHash, resolves: { ledger_id: entry.id, claim: 'answers' } });
  assert.equal(store.events('ledger').find(event => event.type === 'specced').ledger[0].status, 'open');
  append({ type: 'specced', actor: 'steward', see_hash: see, base_spec_hash: store.read('ledger').context.specHash, must: ['Keep records'], how_we_know: ['Read it'], out_of_scope: [], assumptions: [], open_questions: ['Who reviews it?'], ledger: [{ ...entry, status: 'answered', refs: [store.events('ledger').at(-1).body_hash] }] });
  assert.equal(store.events('ledger').at(-1).ledger[0].status, 'answered');
});

test('ledger text must match the spec arrays', t => {
  const { store, append } = setup(t); const see = store.read('ledger').context.seeHash;
  assert.throws(() => append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep'], how_we_know: ['Read'], out_of_scope: [], assumptions: ['Actual'], open_questions: [], ledger: [{ id: 'ledger:0123456789abcdef01234567', kind: 'assumption', text: 'Different', status: 'unverified', refs: [] }] }), /invalid working ledger/);
});

test('rules 2 item refuses ledger fields; legacy replay and hashes verify', t => {
  const { store, append } = setup(t, 2); const see = store.read('ledger').context.seeHash;
  assert.throws(() => append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep'], how_we_know: ['Read'], out_of_scope: [], ledger: [] }), /rules 3 only/);
  append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep'], how_we_know: ['Read'], out_of_scope: [] });
  assert.deepEqual(store.verify('ledger'), { ok: true });
});

test('packet v3 lists open questions and unverified assumptions; v2 packet hash unchanged', () => {
  const legacy = buildPacket({ spec: { hash: 'a' } });
  assert.equal(legacy.v, 2); assert.equal(Object.hasOwn(legacy, 'ledger'), false);
  const packet = buildPacket({ spec: { hash: 'b', rules: 3, ledger: [
    { id: 'ledger:0123456789abcdef01234567', kind: 'question', text: 'Who?', status: 'open', refs: [] },
    { id: 'ledger:0123456789abcdef01234568', kind: 'assumption', text: 'Fixture', status: 'unverified', refs: [] },
  ] } });
  assert.equal(packet.v, 3); assert.equal(packet.openQuestions.length, 1); assert.equal(packet.unverifiedAssumptions.length, 1);
});

test('closeout report carries ledger ids and statuses', () => {
  const event = { type: 'specced', seq: 2, body_hash: 'spec', ledger: [{ id: 'ledger:0123456789abcdef01234567', kind: 'question', text: 'Who?', status: 'answered', refs: [] }] };
  const report = buildCloseout([event], { item: 'ledger', post_id: 'spec:spec', kind: 'spec', opened_seq: 2, closed_seq: 2, snapshot_hash: 'snapshot' }, { hash: 'snapshot', body_hash: 'spec' });
  assert.deepEqual(report.ledger_entries[0].id, 'ledger:0123456789abcdef01234567'); assert.equal(report.ledger_entries[0].status, 'answered');
});
