import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { stopOnSignal, main as cli } from '../cli.js';
import { writeBackup } from '../core/backup.js';
import { appendAudit } from '../core/audit.js';

class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function call(handler, path, headers = {}) { const req = Readable.from([]); req.method = 'GET'; req.url = path; req.headers = headers; req.socket = { remoteAddress: '127.0.0.1' }; const res = new Response(); await handler(req, res); return res; }
const temp = () => join(mkdtempSync(join(tmpdir(), 'sss-ops-')), 'db.sqlite');

test('health is database-free, readiness fails closed, and metrics omit people', async () => {
  const store = new Store(), auth = new Auth(store); await auth.createUser('syntheticleader', 'fixture-password-123', true); await auth.createUser('syntheticmember', 'fixture-password-123');
  const handler = createHandler({ store, auth, secure: false, readiness: () => ({ ok: false, schema_version: 0, expected_schema_version: 22, kill_latch: 'unavailable' }), metricsToken: 'test-token' });
  const health = await call(handler, '/healthz'); assert.equal(health.status, 200); assert.match(health.headers['content-security-policy'], /default-src/);
  const ready = await call(handler, '/readyz'); assert.equal(ready.status, 503);
  const denied = await call(handler, '/metrics-lite'); assert.equal(denied.status, 403);
  const metrics = await call(handler, '/metrics-lite', { authorization: 'Bearer test-token' }); assert.equal(metrics.status, 200);
  assert.equal(readFileSafe(metrics.text).includes('syntheticleader'), false); assert.equal(readFileSafe(metrics.text).includes('syntheticmember'), false);
  store.close();
});
const readFileSafe = value => String(value);

test('shutdown stops resources, closes after listener, and second signal exits immediately', () => {
  const events = [], signals = {}; const proc = { on: (name, fn) => { signals[name] = fn; } };
  const server = { closeIdleConnections() { events.push('idle'); }, close(done) { events.push('close'); done(); } };
  const store = { close() { events.push('store'); } }; const timer = {};
  stopOnSignal(server, store, { proc, timers: [timer], stops: [() => events.push('schedule')], bundleServer: { close() { events.push('bundle'); } }, clearTimer: value => { if (value === timer) events.push('timer'); }, setTimer: () => ({ unref() {} }), exit: code => events.push(`exit:${code}`) });
  signals.SIGTERM(); assert.deepEqual(events, ['timer', 'schedule', 'bundle', 'idle', 'close', 'store', 'exit:0']); signals.SIGINT(); assert.equal(events.at(-1), 'exit:1');
});

test('doctor detects tampered chain, unsafe database permissions, and stale backup', () => {
  const file = temp(); const store = new Store(file); store.registerPerson('writer'); store.append('item', { type: 'checked', actor: 'writer', problem: 'Synthetic issue', looked: ['none'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'one' });
  const dir = mkdtempSync(join(tmpdir(), 'sss-backup-dir-')); const backup = join(dir, 'old.sqlite'); writeBackup(store, backup); const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, 'utf8')); manifest.created_at = '2000-01-01T00:00:00.000Z'; writeFileSync(`${backup}.manifest.json`, JSON.stringify(manifest));
  store.db.prepare("UPDATE events SET prev_hash='tampered' WHERE item='item' AND seq=1").run(); store.close(); chmodSync(file, 0o644);
  const lines = []; return cli(['doctor', '--json', '--backup-dir', dir], { SSS_DB: file }, line => lines.push(line)).then(code => { const report = JSON.parse(lines[0]); assert.equal(code, 1); assert.equal(report.permissions.database.owner_only, false); assert.equal(report.backup.fresh, false); assert.equal(report.chains.items[0].ok, false); });
});

test('backup verify leaves live data alone and prune keeps newest plus invalid backup', async () => {
  const file = temp(), store = new Store(file); const dir = mkdtempSync(join(tmpdir(), 'sss-prune-'));
  for (const name of ['one.sqlite', 'two.sqlite', 'three.sqlite']) writeBackup(store, join(dir, name)); store.close();
  writeFileSync(join(dir, 'one.sqlite'), 'bad');
  const lines = []; await cli(['backup', 'verify', '--from', join(dir, 'three.sqlite')], { SSS_DB: file }, line => lines.push(line)); assert.match(lines[0], /verified/);
  await cli(['backup', 'prune', '--dir', dir, '--keep', '1'], { SSS_DB: file }, () => {});
  assert.equal(readFileSync(join(dir, 'three.sqlite')).length > 0, true); assert.equal(readFileSync(join(dir, 'one.sqlite')).toString(), 'bad');
});
