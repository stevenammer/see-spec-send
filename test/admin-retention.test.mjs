import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';

test('retention is off by default, proposes rather than deletes, and a legal hold blocks erasure until release', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('leader', 'fixture-password-123', true); await auth.createUser('member', 'fixture-password-123');
  const at = '2020-01-01T00:00:00.000Z'; store.append('case', { type: 'posted', actor: 'member', rules: 3, original: 'Synthetic private issue', at }, { idem: 'posted' });
  const base = store.read('case').context.activePost; store.append('case', { type: 'commented', actor: 'leader', kind: 'comment', comment: 'Synthetic comment', anchor_kind: 'see', anchor_hash: store.read('case').context.seeHash, post_id: base.id, post_version: base.version, at }, { idem: 'comment' });
  const comment = store.events('case').at(-1).body_hash;
  assert.deepEqual(store.retentionSettings(), { closeout_artifacts: 0, comments: 0, ledger_answers: 0, receipts: 0 }); assert.deepEqual(store.retentionProposals('2026-01-01T00:00:00.000Z'), []);
  store.setRetention('comments', 1); assert.equal(store.retentionProposals('2026-01-01T00:00:00.000Z')[0].id, comment);
  store.hold('item', 'case', 'leader', 'preserve for review', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(store.retentionProposals('2026-01-01T00:00:00.000Z'), []); assert.throws(() => store.erase('case', comment, 'leader', '2026-01-01T00:00:00.000Z'), /legal hold/);
  store.releaseHold('item', 'case', 'leader', '2026-01-02T00:00:00.000Z'); store.erase('case', comment, 'leader', '2026-01-02T00:00:00.000Z');
});

test('admin people list includes kind and durable last sign-in', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('leader', 'fixture-password-123', true); const login = await auth.login('leader', 'fixture-password-123'); assert.ok(login.value);
  const row = auth.listPeople().find(person => person.id === 'leader'); assert.equal(row.kind, 'person'); assert.ok(row.last_sign_in);
});
