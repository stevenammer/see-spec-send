import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';

const at = '2026-11-16T12:00:00.000Z';
test('posted audience is an immutable group read scope', t => {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('sam'); store.registerPerson('riya'); store.registerPerson('pat');
  store.groupCreate('Reservations', 'night shift export'); store.groupAdd('Reservations', 'riya');
  store.append('restricted', { type: 'posted', actor: 'sam', rules: 3, original: 'Synthetic private export issue', audience: ['Reservations'], at }, { idem: 'post' });
  assert.equal(store.canRead('riya', 'restricted'), true);
  assert.equal(store.canRead('pat', 'restricted'), false);
  assert.throws(() => store.append('restricted', { type: 'revised', actor: 'sam', text: 'widen it', base_hash: store.read('restricted').context.seeHash, audience: [], post_id: store.read('restricted').context.activePost.id, post_version: store.read('restricted').context.activePost.version, at }, { idem: 'widen' }), /audience/);
});
