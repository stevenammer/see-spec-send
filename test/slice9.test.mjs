import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { itemPage } from '../app/pages.js';

const at = n => `2026-11-10T00:00:${String(n).padStart(2, '0')}.000Z`;
const put = (store, type, actor, body, n) => store.append('i', { type, actor, at: at(n), ...body }, { idem: `${type}:${n}` });
function ready() {
  const store = new Store();
  store.registerPerson('steward'); store.registerPerson('member'); store.registerPerson('next');
  store.registerPerson('leader', { leader: true }); store.registerToken('run', { kind: 'run', item: 'i' });
  put(store, 'checked', 'steward', { problem: 'Synthetic issue', looked: ['Synthetic check'], found: [], verdict: 'build_needed', evidence: [{ url: 'https://example.test/check', claim: 'Synthetic record', kind: 'documented' }] }, 1);
  put(store, 'specced', 'steward', { must: ['x'], how_we_know: ['x'], out_of_scope: [] }, 2);
  const spec = store.read('i').context.specHash;
  put(store, 'approved', 'leader', { spec_hash: spec, cap_usd: 0, quorum: 1 }, 3);
  put(store, 'tried', 'run', { approval: 1, spec_hash: spec, artifact_hash: 'a' }, 4);
  return store;
}

test('versioned comments become stale, while sources retain their honesty label', () => {
  const store = ready();
  assert.throws(() => put(store, 'commented', 'member', { comment: 'unanchored' }, 5), /not allowed|terminal state/);
  put(store, 'commented', 'member', { comment: 'on this try', anchor_kind: 'artifact', anchor_hash: 'a' }, 5);
  put(store, 'helped', 'member', { artifact_hash: 'a', evidence: [{ url: 'https://example.test/report', claim: 'It reduced a synthetic step', kind: 'reported', reported_by: 'member' }] }, 6);
  const html = itemPage({ id: 'i', ...store.read('i') }, store.events('i'), 'member', false);
  assert.match(html, /current version/);
  assert.throws(() => put(store, 'helped', 'next', { artifact_hash: 'a', evidence: [{ url: 'https://example.test/x', claim: 'x', kind: 'reported' }] }, 7), /not allowed|terminal state/);
});

test('check-ins cannot approve, vote, or weaken a stewardship handoff', () => {
  const store = ready();
  put(store, 'checked_in', 'member', { note: 'Synthetic status update' }, 5);
  put(store, 'steward_changed', 'leader', { steward: 'next' }, 6);
  assert.throws(() => put(store, 'helped', 'steward', { artifact_hash: 'a' }, 7), /not allowed|terminal state/);
  assert.throws(() => put(store, 'steward_changed', 'member', { steward: 'member' }, 8), /not allowed|terminal state/);
  assert.equal(store.read('i').context.steward, 'next');
  assert.ok(store.verify('i').ok);
});
