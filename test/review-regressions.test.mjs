import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { usdToMicros } from '../core/machine.js';
import { Auth } from '../app/auth.js';
import { itemPage } from '../app/pages.js';

let tick = 0;
const at = () => `2026-11-09T00:00:${String(++tick).padStart(2, '0')}.000Z`;
const event = (type, actor, body = {}) => ({ type, actor, at: at(), ...body });

function ready(store, quorum = 2) {
  for (const id of ['author', 'next', 'helper']) store.registerPerson(id);
  store.registerPerson('leader', { leader: true });
  store.registerToken('run', { kind: 'run', item: 'i' });
  store.append('i', event('checked', 'author', {
    problem: 'private problem', looked: ['private note'], found: [], verdict: 'build_needed',
  }), { idem: 'checked' });
  const spec = store.append('i', event('specced', 'author', {
    must: ['private must'], how_we_know: ['private proof'], out_of_scope: [],
  }), { idem: 'specced' }).context.specHash;
  store.append('i', event('approved', 'leader', { spec_hash: spec, cap_usd: 1, quorum }), { idem: 'approved' });
  store.append('i', event('tried', 'run', { approval: 1, spec_hash: spec, artifact_hash: 'try' }), { idem: 'tried' });
}

test('spec authors and past stewards never become helpers', () => {
  const store = new Store();
  ready(store, 1);
  store.append('i', event('steward_changed', 'leader', { steward: 'next' }), { idem: 'handoff' });
  assert.throws(() => store.append('i', event('helped', 'author', { artifact_hash: 'try' }), {
    idem: 'author-helps',
  }), /not allowed/);
  store.append('i', event('helped', 'helper', { artifact_hash: 'try' }), { idem: 'helper-helps' });
  assert.throws(() => store.append('i', event('helped', 'next', { artifact_hash: 'try' }), {
    idem: 'steward-helps',
  }), /terminal|not allowed/);
});

test('authority snapshots preserve history and detect tampering', () => {
  const store = new Store();
  ready(store);
  const before = store.read('i');
  store.registerPerson('leader', { leader: false });
  assert.deepEqual(store.read('i'), before);
  store.append('i', event('helped', 'helper', { artifact_hash: 'try' }), { idem: 'help' });
  assert.equal(store.verify('i').ok, true);
  store.db.prepare("UPDATE events SET actor_leader=0 WHERE type='approved'").run();
  assert.equal(store.verify('i').ok, false);
});

test('redacted critical bodies replay, transfer, and remove original text', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sss-redact-')), 'store.db');
  const store = new Store(file);
  ready(store);
  const first = store.eventRows('i')[0].body_hash;
  store.erase('i', first, 'leader', at());
  assert.equal(store.read('i').state, 'TRYING');
  store.append('i', event('helped', 'helper', { artifact_hash: 'try' }), { idem: 'help' });
  assert.equal(store.verify('i').ok, true);
  const copy = new Store();
  copy.importJsonl(store.exportJsonl());
  assert.equal(copy.read('i').state, 'TRYING');
  assert.deepEqual(copy.actor('author', 'i'), { kind: 'person', leader: false });
  assert.deepEqual(copy.actor('leader', 'i'), { kind: 'person', leader: true });
  assert.deepEqual(copy.actor('run', 'i'), { kind: 'run', leader: false });
  assert.throws(() => copy.actor('run', 'other-item'), /scoped/);
  assert.equal(copy.append('i', event('helped', 'next', { artifact_hash: 'try' }), {
    idem: 'restored-next-helper',
  }).state, 'HELPS');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
  assert.equal(readFileSync(file).toString('latin1').includes('private problem'), false);
});

test('micro-dollars accept every six-decimal amount and reject extra precision', () => {
  for (let k = 1; k <= 200_000; k += 1) assert.equal(usdToMicros(k / 1_000_000), k);
  assert.equal(usdToMicros(123456.123456), 123456123456);
  for (const value of [0.0000001, -1, NaN, Infinity]) assert.equal(usdToMicros(value), null);
});

test('redeem does not hold a transaction while password work is pending', async () => {
  const store = new Store();
  const auth = new Auth(store);
  await auth.createUser('taken', 'a long enough password');
  store.registerPerson('worker');
  const invite = auth.createInvite('member');
  let release;
  const original = auth.passwordRecord.bind(auth);
  auth.passwordRecord = async password => {
    await new Promise(resolve => { release = resolve; });
    return original(password);
  };
  const pending = auth.redeem(invite, 'taken', 'a second long password', 'test-ip');
  await new Promise(resolve => setImmediate(resolve));
  store.append('item', event('checked', 'worker', {
    problem: 'safe write', looked: ['x'], found: [], verdict: 'build_needed',
  }), { idem: 'write' });
  release();
  await assert.rejects(pending, /UNIQUE/);
  assert.equal(store.read('item').state, 'CHECKED');
  assert.equal(store.db.prepare('SELECT used FROM invites').get().used, 0);
});

test('an erased flag without a sealed erasure receipt never bypasses body verification', () => {
  const store = new Store();
  ready(store);
  const target = store.eventRows('i')[0].body_hash;
  store.db.prepare('UPDATE bodies SET erased=1 WHERE hash=?').run(target);
  assert.equal(store.verify('i').ok, false);
});

test('redaction removes unknown personal fields and detects changed structural tombstones', () => {
  const store = new Store();
  store.registerPerson('author');
  store.registerPerson('leader', { leader: true });
  store.append('i', event('checked', 'author', {
    problem: 'Synthetic personal writing', looked: ['a setting'], found: [],
    verdict: 'build_needed', custom: { note: 'Synthetic private extra field' },
  }), { idem: 'source' });
  const target = store.eventRows('i')[0].body_hash;
  store.erase('i', target, 'leader', at());
  assert.equal(store.exportJsonl().includes('Synthetic private extra field'), false);
  assert.equal(store.verify('i').ok, true);
  const body = JSON.parse(store.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(target).bytes);
  body.verdict = 'already_have';
  store.db.prepare('UPDATE bodies SET bytes=? WHERE hash=?').run(JSON.stringify(body), target);
  assert.equal(store.verify('i').ok, false);
});


test('past shapers never see a helper vote after a stewardship handoff', () => {
  const store = new Store();
  ready(store);
  store.append('i', event('steward_changed', 'leader', { steward: 'next' }), {
    idem: 'handoff-page',
  });
  const item = { id: 'i', ...store.read('i') };
  for (const person of ['author', 'next', 'leader']) {
    const html = itemPage(item, store.events('i'), person, person === 'leader');
    assert.equal(html.includes('data-event="helped"'), false, person);
    assert.ok(html.includes('others say whether it helps'));
  }
  assert.ok(itemPage(item, store.events('i'), 'helper', false).includes('data-event="helped"'));
});
