import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { main as cli } from '../cli.js';

const password = 'correct-horse-9-battery';
const temp = () => join(mkdtempSync(join(tmpdir(), 'sss-hard-')), 'db.sqlite');
const quiet = () => {};

function seeded(file) {
  const store = new Store(file);
  store.registerPerson('member');
  store.append('item', {
    type: 'checked', actor: 'member', at: '2026-11-09T00:00:00.000Z',
    looked: ['x'], found: [], verdict: 'free',
  }, { idem: 'one' });
  return store;
}

test('the database and its backups are private to the owner', async () => {
  const file = temp();
  const store = new Store(file);
  store.close();
  assert.equal(statSync(file).mode & 0o077, 0, 'database must not be group or world readable');
  const target = join(dirname(file), 'backup.sqlite');
  await cli(['backup', '--to', target], { ...process.env, SSS_DB: file }, quiet);
  assert.equal(statSync(target).mode & 0o077, 0, 'backup must not be group or world readable');
  await assert.rejects(cli(['backup', '--to', target], { ...process.env, SSS_DB: file }, quiet), /exists/);
});

test('the first password comes from a secure random source and is long', async () => {
  const seen = new Set();
  for (let index = 0; index < 3; index += 1) {
    const lines = [];
    await cli(['init'], { ...process.env, SSS_DB: temp() }, line => lines.push(line));
    const value = lines.join('\n').match(/one-time password: (\S+)/)[1];
    assert.match(value, /^Start-[A-Za-z0-9_-]{24,}-9a$/);
    seen.add(value);
  }
  assert.equal(seen.size, 3);
});

test('verify catches forged submission metadata, orphaned events and cache drift', () => {
  const forgedHash = seeded(temp());
  forgedHash.db.prepare("UPDATE events SET submitted_hash='forged' WHERE item='item'").run();
  assert.equal(forgedHash.verify('item').ok, false);
  assert.equal(forgedHash.verifyAll()[0].ok, false);

  const forgedIdem = seeded(temp());
  forgedIdem.db.prepare("UPDATE events SET idem='forged' WHERE item='item'").run();
  assert.equal(forgedIdem.verify('item').ok, false);

  const orphan = seeded(temp());
  orphan.db.prepare('DELETE FROM items').run();
  const missing = orphan.verifyAll();
  assert.equal(missing.length, 1, 'an item with events but no cache row must still be listed');
  assert.equal(missing[0].ok, false);

  const drift = seeded(temp());
  drift.db.prepare("UPDATE items SET state='HELPS' WHERE item='item'").run();
  assert.equal(drift.verifyAll()[0].ok, false);

  const clean = seeded(temp());
  assert.deepEqual(clean.verifyAll(), [{ item: 'item', ok: true }]);
});

test('strangers failing from other addresses cannot lock the owner out', async () => {
  let time = 1_000_000_000_000;
  const auth = new Auth(new Store(), { clock: () => time });
  await auth.createUser('owner', password, true);
  for (let index = 0; index < 8; index += 1) {
    await assert.rejects(auth.login('owner', 'wrong-password-123', `198.51.100.${index}`));
  }
  const session = await auth.login('owner', password, '203.0.113.9');
  assert.ok(session.value, 'the owner logs in from a fresh address');
});

test('one address that keeps failing is locked out, and recovers after the window', async () => {
  let time = 1_000_000_000_000;
  const auth = new Auth(new Store(), { clock: () => time });
  await auth.createUser('owner', password, true);
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(auth.login('owner', 'wrong-password-123', '198.51.100.7'));
    // Wait just past the current lock so the next guess is allowed and counts.
    if (index < 3) time += 2 ** (index + 1) * 1000 + 1;
  }
  time += 100;
  await assert.rejects(auth.login('owner', password, '198.51.100.7'), /unavailable/);
  time += 16 * 60_000;
  assert.ok((await auth.login('owner', password, '198.51.100.7')).value);
});

test('spread-out guessing hits a ceiling that expires on its own', async () => {
  let time = 1_000_000_000_000;
  const auth = new Auth(new Store(), { clock: () => time });
  await auth.createUser('owner', password, true);
  for (let index = 0; index < 35; index += 1) {
    await assert.rejects(auth.login('owner', 'wrong-password-123', `192.0.2.${index}`));
  }
  await assert.rejects(auth.login('owner', password, '203.0.113.50'), /unavailable/);
  time += 16 * 60_000;
  assert.ok((await auth.login('owner', password, '203.0.113.50')).value);
});

test('the rate limiter forgets idle identities and has a hard size cap', () => {
  let time = 1_000_000_000_000;
  const auth = new Auth(new Store(), { clock: () => time });
  for (let index = 0; index < 12_000; index += 1) auth.take(`probe:${index}`);
  time += 10 * 60_000;
  auth.take('trigger');
  assert.ok(auth.buckets.size < 2_000, `idle buckets must be pruned, found ${auth.buckets.size}`);
  for (let index = 0; index < 60_000; index += 1) auth.take(`flood:${index}`);
  assert.ok(auth.buckets.size <= 50_000, `size must stay capped, found ${auth.buckets.size}`);
});
