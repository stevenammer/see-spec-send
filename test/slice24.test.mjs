import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Integrations, hmac } from '../app/integrations.js';
import { main as cli } from '../cli.js';

const secret = 'this-is-a-long-test-secret';
const inbound = (problem = 'Synthetic queue failure') => Buffer.from(JSON.stringify({ problem, source_label: 'Synthetic Slack', honesty_label: 'reported' }));
class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
const request = async (handler, path, headers, value) => { const req = Readable.from([value]); req.method = 'POST'; req.url = path; req.headers = { 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: '127.0.0.1' }; const res = new Response(); await handler(req, res); return { status: res.status, body: JSON.parse(res.text) }; };
const directory = t => { const dir = mkdtempSync(join(tmpdir(), 'sss-s24-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

// B20: the replay key is derived from the signed timestamp and body only. A changed Idempotency-Key
// header must not make the same signed request count as new.
test('B20: a signed inbound request cannot be replayed under a new Idempotency-Key', async () => {
  const now = 1_000_000; const store = new Store(); const auth = new Auth(store);
  const integrations = new Integrations(store, { clock: () => now }); integrations.addSource('slack', secret);
  const handler = createHandler({ store, auth, integrations, secure: false, origin: 'http://127.0.0.1' });
  const body = inbound(); const headers = { 'x-sss-timestamp': String(now), 'x-sss-signature': `sha256=${hmac(secret, String(now), body)}` };
  assert.equal((await request(handler, '/api/integrations/inbound/slack', { ...headers, 'idempotency-key': 'first' }, body)).status, 201);
  const replay = await request(handler, '/api/integrations/inbound/slack', { ...headers, 'idempotency-key': 'a-new-key' }, body);
  assert.equal(replay.status, 409);
  assert.equal(store.listItems().length, 1, 'the replay must create no item');
});

// B21: erasure is a CLI command with an explicit actor and reason. The reason is audited, verify stays ok.
test('B21: erase runs from the CLI with an actor and a reason, is audited, and leaves verify ok', async t => {
  const file = join(directory(t), 'db.sqlite');
  const store = new Store(file); store.registerPerson('leader', { leader: true });
  store.append('item', { type: 'checked', actor: 'leader', problem: 'private problem', looked: ['checked'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'event' });
  const hash = store.eventRows('item')[0].body_hash; store.close();
  const env = { SSS_DB: file }; const lines = []; const write = value => lines.push(value);
  await assert.rejects(cli(['erase', '--item', 'item', '--body-hash', hash, '--actor', 'leader'], env, write), /missing --reason/);
  await assert.rejects(cli(['erase', '--item', 'item', '--body-hash', hash, '--reason', 'privacy request 42'], env, write), /missing --actor/);
  await cli(['erase', '--item', 'item', '--body-hash', hash, '--actor', 'leader', '--reason', 'privacy request 42'], env, write);
  const reader = new Store(file);
  assert.equal(reader.db.prepare('SELECT erased FROM bodies WHERE hash=?').get(hash).erased, 1);
  assert.deepEqual(reader.verify('item'), { ok: true });
  reader.close();
  await cli(['verify'], env, write);
  assert.ok(lines.includes('item: ok') && lines.includes('audit: ok'), lines.join('\n'));
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT outcome, detail FROM admin_audit WHERE command='erase'").all(); db.close();
  const ok = rows.find(row => row.outcome === 'ok');
  assert.ok(ok, 'a successful erase must leave an ok audit row');
  assert.match(ok.detail, /privacy request 42/);
});

// Disable stops intake without deleting anything. Remove is only allowed after disable.
test('integration source and destination can be disabled, and removed only after disable', async t => {
  const file = join(directory(t), 'db.sqlite'); const env = { SSS_DB: file, S24_SECRET: secret }; const lines = []; const write = value => lines.push(value);
  await cli(['integration', 'source', 'add', '--name', 'slack', '--secret-env', 'S24_SECRET'], env, write);
  await cli(['integration', 'destination', 'add', '--name', 'hook', '--url', 'https://example.com/hook', '--secret-env', 'S24_SECRET'], env, write);
  await cli(['integration', 'source', 'disable', '--name', 'slack'], env, write);
  await cli(['integration', 'destination', 'disable', '--name', 'hook'], env, write);
  let store = new Store(file); let integrations = new Integrations(store);
  assert.equal(integrations.list('source')[0].enabled, 0);
  assert.equal(integrations.list('destination')[0].enabled, 0);
  const bytes = inbound(); const timestamp = String(Date.now());
  assert.throws(() => integrations.receive('slack', timestamp, `sha256=${hmac(secret, timestamp, bytes)}`, bytes, { 'idempotency-key': 'after-disable' }), /inbound refused/);
  store.close();
  await cli(['integration', 'destination', 'add', '--name', 'live', '--url', 'https://example.com/live', '--secret-env', 'S24_SECRET'], env, write);
  await assert.rejects(cli(['integration', 'destination', 'remove', '--name', 'live'], { SSS_DB: file }, write), /disable it first/);
  await cli(['integration', 'source', 'remove', '--name', 'slack'], { SSS_DB: file }, write);
  await cli(['integration', 'destination', 'remove', '--name', 'hook'], { SSS_DB: file }, write);
  await cli(['integration', 'destination', 'disable', '--name', 'live'], { SSS_DB: file }, write);
  await cli(['integration', 'destination', 'remove', '--name', 'live'], { SSS_DB: file }, write);
  store = new Store(file); integrations = new Integrations(store);
  assert.deepEqual(integrations.list('source'), []);
  assert.deepEqual(integrations.list('destination'), []);
  store.close();
  assert.ok(lines.includes('integration source slack removed'));
});

// Backup encryption: AES-256-GCM under a key file that is not in the backup. Restore needs the key file.
test('backup --encrypt-to writes AES-256-GCM that restore reads only with the key file', async t => {
  const dir = directory(t); const file = join(dir, 'db.sqlite'); const env = { SSS_DB: file }; const lines = []; const write = value => lines.push(value);
  const store = new Store(file); store.registerPerson('leader', { leader: true });
  store.append('item', { type: 'checked', actor: 'leader', problem: 'private problem', looked: ['checked'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'event' });
  store.close();
  const keyFile = join(dir, 'backup.key'); const target = join(dir, 'backup.enc'); const restored = join(dir, 'restored.db');
  await cli(['backup', '--to', target, '--encrypt-to', keyFile], env, write);
  assert.equal(statSync(keyFile).mode & 0o077, 0, 'the key file must be owner-only');
  assert.equal(readFileSync(target).includes(Buffer.from('private problem')), false, 'the encrypted backup must hold no plaintext');
  await assert.rejects(cli(['restore', '--from', target], { SSS_DB: restored }, write), /key-file/);
  assert.equal(existsSync(restored), false, 'a refused restore must create nothing');
  await cli(['restore', '--from', target, '--key-file', keyFile], { SSS_DB: restored }, write);
  const shortKey = join(dir, 'short.key'); writeFileSync(shortKey, Buffer.alloc(16, 1), { mode: 0o600 });
  await assert.rejects(cli(['backup', '--to', join(dir, 'short.enc'), '--encrypt-to', shortKey], env, write), /exactly 32 bytes/);
  assert.equal(existsSync(join(dir, 'short.enc')), false, 'a bad key must create no backup');
  const copy = new Store(restored);
  assert.equal(copy.eventCount('item'), 1);
  assert.deepEqual(copy.verifyAll(), [{ item: 'item', ok: true }]);
  assert.equal(copy.db.prepare('SELECT killed FROM worker_control WHERE id=1').get().killed, 1, 'the restored copy starts stopped');
  copy.close();
  await assert.rejects(cli(['restore', '--from', target, '--key-file', join(dir, 'other.key')], { SSS_DB: join(dir, 'x.db') }, write));
});

// B19: a planted secret never appears in the database bytes or in a backup. The key lives in its own owner-only file.
test('B19: secrets are sealed at rest, absent from the database and a backup, and rotate with an overlap', async t => {
  const dir = directory(t); const file = join(dir, 'db.sqlite'); const planted = 'PLANTED-secret-value-0123456789';
  const lines = []; const write = value => lines.push(value); const env = { SSS_DB: file, PLANTED: planted };
  await cli(['init'], env, write).catch(() => {});
  await cli(['integration', 'source', 'add', '--name', 'slack', '--secret-env', 'PLANTED'], env, write);
  await cli(['integration', 'destination', 'add', '--name', 'hook', '--url', 'https://example.com/h', '--secret-env', 'PLANTED'], env, write);
  const key = `${file}.secret-key`;
  assert.equal(existsSync(key), true); assert.equal(statSync(key).mode & 0o077, 0, 'key file must be owner-only');
  const scan = path => readFileSync(path).includes(Buffer.from(planted));
  assert.equal(scan(file), false, 'plaintext must not be in the database file');
  for (const extra of [`${file}-wal`]) if (existsSync(extra)) assert.equal(scan(extra), false);
  const backup = join(dir, 'backup.sqlite');
  await cli(['backup', '--to', backup], env, write);
  assert.equal(scan(backup), false, 'plaintext must not be in a backup');
  assert.equal(lines.join('\n').includes(planted), false, 'plaintext must not be printed');

  // Rotation: old and new both verify inside the overlap, only the new one after it.
  let now = 5_000_000; const store = new Store(file); const integrations = new Integrations(store, { clock: () => now });
  const fresh = 'a-brand-new-rotated-secret-99';
  integrations.rotate('source', 'slack', fresh, 1);
  let n = 0; const check = (use) => { const body = inbound(`call ${n += 1}`); return () => integrations.receive('slack', String(now), hmac(use, String(now), body), body, { 'idempotency-key': `k${now}${use.length}` }); };
  assert.doesNotThrow(check(fresh)); assert.doesNotThrow(check(planted));
  now += 2 * 3_600_000;
  assert.doesNotThrow(check(fresh)); assert.throws(check(planted));
  store.close();
  assert.equal(scan(file), false);
});

test('B19: a database opened with the wrong key cannot read the secret', async t => {
  const dir = directory(t); const file = join(dir, 'db.sqlite');
  const store = new Store(file); new Integrations(store).addSource('slack', secret); store.close();
  const other = new Store(file); const integrations = new Integrations(other, { keyFile: join(dir, 'other.key') });
  writeFileSync(join(dir, 'other.key'), '11'.repeat(32), { mode: 0o600 });
  const stored = other.db.prepare('SELECT secret FROM integration_sources').get().secret;
  assert.throws(() => integrations.unpack(stored)); other.close();
});

test('B19: a loose key file is tightened to owner-only when it is used', t => {
  const dir = directory(t); const file = join(dir, 'db.sqlite'); const key = join(dir, 'loose.key');
  writeFileSync(key, '22'.repeat(32), { mode: 0o644 });
  const store = new Store(file); new Integrations(store, { keyFile: key }).addSource('slack', secret); store.close();
  assert.equal(statSync(key).mode & 0o077, 0);
});
