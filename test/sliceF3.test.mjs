import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { buildPacket, RESEARCH_SOURCES } from '../core/packet.js';
import { itemPage } from '../app/pages.js';

const at = n => `2026-11-14T00:00:${String(n).padStart(2, '0')}.000Z`;
const append = (store, event, n) => store.append('f3', { ...event, at: at(n) }, { idem: `f3:${n}` });
const setup = () => {
  const store = new Store();
  store.registerPerson('op'); store.registerPerson('member'); store.registerPerson('leader', { leader: true });
  append(store, { type: 'posted', actor: 'op', original: 'Customers repeat their account details.', rules: 2 }, 1);
  const see = store.read('f3').context.seeHash;
  append(store, { type: 'commented', actor: 'member', comment: 'The handoff loses the caller note.', kind: 'concern', anchor_kind: 'see', anchor_hash: see }, 2);
  append(store, { type: 'specced', actor: 'op', see_hash: see, must: ['Keep the caller note'], how_we_know: ['A caller sees it'], out_of_scope: [] }, 3);
  const spec = store.read('f3').context.specHash;
  const packet = store.putArtifact('f3', JSON.stringify({ specHash: spec }));
  append(store, { type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet }, 4);
  return { store, see, spec, packet };
};

test('F3 decisions are attributable, reasoned, bounded, and Not building is terminal history not a block on new SEEs', () => {
  const { store, spec, packet } = setup();
  for (const type of ['approved', 'returned', 'not_built']) {
    assert.throws(() => append(store, { type, actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'short', cap_usd: 1, quorum: 1 }, 5), /not allowed/);
  }
  append(store, { type: 'not_built', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'Use the existing handoff view before building another one.', restricted_evidence: 'a restricted source exists; ask Legal', pivot_note: 'A later test can cite new evidence.' }, 5);
  const state = store.read('f3');
  assert.equal(state.state, 'SPECCED');
  assert.equal(state.context.decided.disposition, 'not_built');
  assert.equal(state.context.decided.packetHash, packet);
  assert.equal(state.context.decided.restrictedEvidence, 'a restricted source exists; ask Legal');
  const page = itemPage({ id: 'f3', ...state, packet: store.artifact('f3', packet) }, store.events('f3'), 'member', false);
  assert.match(page, /Not building/); assert.match(page, /Use the existing handoff view/);
  store.append('related', { type: 'posted', actor: 'member', original: 'A related SEE can still be posted.', rules: 2, at: at(6) }, { idem: 'related' });
  assert.equal(store.read('f3').context.decided.disposition, 'not_built');
});

test('F3 approval records a fixed leash and machine refuses a sixth steer or a steer after expiry', () => {
  const { store, spec, packet } = setup();
  append(store, { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'A small, independently checked try is worth doing.', cap_usd: 1, quorum: 1,
    max_iterations: 2, window_minutes: 1, expires_at: '2026-11-14T00:01:05.000Z' }, 5);
  const context = store.read('f3').context;
  assert.equal(context.leash.maxIterations, 2); assert.equal(context.leash.expiresAt, '2026-11-14T00:01:05.000Z');
  append(store, { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: 'Keep the note visible.' }, 6);
  append(store, { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: 'Put it above the transfer.' }, 7);
  assert.throws(() => append(store, { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: 'A third turn is outside this decision.' }, 8), /not allowed/);
});

test('F3 packet honestly lists exactly six disconnected research slots and the do-nothing option', () => {
  const packet = buildPacket({ original: 'Original', see: 'Current SEE', spec: { hash: 'spec' }, comments: [] });
  assert.deepEqual(Object.keys(packet.researched), RESEARCH_SOURCES);
  assert.ok(Object.values(packet.researched).every(entry => entry.status === 'not connected' && entry.finding === 'nothing checked'));
  assert.equal(packet.doNothing, 'Do nothing / use what we have');
});

test('F3 erasure protects decisions and requires a privacy ground plus note for another person, leaving a tombstone', () => {
  const { store, see } = setup();
  append(store, { type: 'commented', actor: 'op', comment: 'My note includes a customer account number.', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 5);
  const comment = store.events('f3').at(-1).body_hash;
  assert.throws(() => store.erase('f3', comment, 'leader', at(5)), /ground/);
  assert.throws(() => store.erase('f3', comment, 'member', at(5), { ground: 'privacy', note: 'Remove personal account details.' }), /not allowed/);
  store.erase('f3', comment, 'leader', at(5), { ground: 'privacy', note: 'Remove personal account details.' });
  const erased = store.events('f3').at(-1);
  assert.equal(erased.type, 'erased'); assert.equal(erased.ground, 'privacy'); assert.match(erased.note, /personal/);
  assert.throws(() => store.erase('f3', store.events('f3').find(event => event.type === 'sent').body_hash, 'op', at(6)), /decision records|cannot erase/);
  assert.deepEqual(store.verifyAll(), [{ item: 'f3', ok: true }]);
});

// The rules must hold for a direct append and an import, not only for store.erase().
test('F3 erase rules hold for a direct append of an erased event', () => {
  const { store } = setup();
  const comment = store.events('f3')[1].body_hash; // the member's comment
  const op = store.events('f3')[0].body_hash;       // the original SEE
  const erased = (actor, body_hash, extra = {}, n = 9) => () => store.append('f3', { type: 'erased', actor, body_hash, redacted_hash: 'r'.repeat(64), ...extra, at: at(n) }, { idem: `direct:${actor}:${n}` });
  store.registerPerson('other');
  assert.throws(erased('other', comment), /not allowed/, 'a person who is neither the author, a leader nor the steward cannot erase it');
  assert.throws(erased('op', comment), /ground/, 'the steward needs a stated ground to erase someone else');
  assert.throws(erased('leader', comment), /ground/);
  assert.throws(erased('leader', comment, { ground: 'privacy' }), /note/);
  assert.throws(erased('leader', op, { ground: 'privacy', note: 'x' }), /decision records|original/);
  assert.throws(erased('member', op), /decision records|original/);
});
