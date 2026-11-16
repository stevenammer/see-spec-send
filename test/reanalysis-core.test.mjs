import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { extractDeltas } from '../knowledge/delta.js';
import { runReanalysis } from '../reanalysis/run.js';

const now = '2026-11-16T12:00:00.000Z';

test('knowledge chain verifies and detects tamper', () => {
  const store = new Store();
  store.knowledge.append('receipt', { v: 1, checked: true }, { at: now });
  assert.deepEqual(store.knowledge.verify(), { ok: true });
  store.db.prepare("UPDATE knowledge_log SET body='{}' WHERE seq=1").run();
  assert.deepEqual(store.knowledge.verify(), { ok: false, reason: 'chain' });
  store.close();
});

test('agent authored text never becomes a delta', () => {
  const store = new Store();
  store.registerPerson('op');
  store.append('one', { type: 'posted', actor: 'op', original: 'An export needs work.', rules: 3, at: now }, { idem: 'one' });
  // The event store registers effort as an agent during migration.
  store.append('one', { type: 'commented', actor: 'effort', kind: 'agent', comment: 'new integration solved everything',
    job: 'job', receipt: 'receipt', model: 'none', anchor_kind: 'see', anchor_hash: store.read('one').context.seeHash,
    post_id: store.read('one').context.activePost.id, post_version: store.read('one').context.activePost.version, at: now }, { idem: 'two' });
  assert.deepEqual(extractDeltas(store, { now }), []);
  store.close();
});

test('reanalysis is isolated per Store', () => {
  const first = new Store(), second = new Store();
  first.knowledge.append('receipt', { v: 1, first: true }, { at: now });
  assert.equal(second.knowledge.entries().length, 0);
  assert.deepEqual(runReanalysis(second, { now }), { deltas: [], annexes: [], held: [], receipts: [], skipped: [] });
  first.close(); second.close();
});
