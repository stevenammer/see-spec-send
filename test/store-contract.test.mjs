import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { FakePostgresStore } from '../core/postgres-store.js';

const event = (type, actor, body = {}, at = '2026-11-11T00:00:00.000Z') => ({ type, actor, at, ...body });
const register = store => {
  store.registerPerson('steward');
  store.registerPerson('leader', { leader: true });
  store.registerToken('gateway', { kind: 'gateway', item: 'item' });
};

// This suite is intentionally storage-agnostic. Add every cross-adapter
// invariant here before relying on another Store backend.
function storeContract(name, make) {
  test(`${name}: registry scope, chain, cache and replay agree`, () => {
    const store = make();
    try {
      register(store);
      assert.throws(() => store.append('elsewhere', event('charged', 'gateway', { usd: 0 }), { idem: 'wrong-item' }), /scoped/);
      const checked = event('checked', 'steward', {
        problem: 'A visible problem', looked: ['a check'], found: [], verdict: 'build_needed',
      });
      store.append('item', checked, { idem: 'checked' });
      store.append('item', event('specced', 'steward', {
        must: ['A bounded change'], how_we_know: ['A person can check it'], out_of_scope: ['Network calls'],
      }, '2026-11-11T00:00:01.000Z'), { idem: 'specced' });
      const spec = store.read('item').context.specHash;
      store.append('item', event('approved', 'leader', { spec_hash: spec, cap_usd: 1, quorum: 1 },
        '2026-11-11T00:00:02.000Z'), { idem: 'approved' });
      const binding = store.read('item').context;
      const charged = event('charged', 'gateway', { usd: 0.01, approval: binding.approval,
        spec_hash: binding.specHash }, '2026-11-11T00:00:03.000Z');
      store.append('item', charged, { idem: 'charged' });
      assert.equal(store.append('item', charged, { idem: 'charged' }).idempotent, true);
      assert.throws(() => store.append('item', { ...charged, usd: 0.02 }, { idem: 'charged' }), /different event/);
      assert.deepEqual(store.verify('item'), { ok: true });
      assert.deepEqual(store.cache('item'), store.read('item').context);
      store.rebuild();
      assert.deepEqual(store.verifyAll(), [{ item: 'item', ok: true }]);
    } finally { store.close(); }
  });
}

storeContract('sqlite Store', () => new Store());
storeContract('in-process Postgres fake', () => new FakePostgresStore());

