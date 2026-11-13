import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Worker } from '../worker/runner.js';
import { Ledger } from '../gateway/ledger.js';
import { killed } from '../worker/control.js';

const password = 'correct-horse-9-battery';
class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function call(handler, method, path, input, headers = {}) { const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path; req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' }; const res = new Response(); await handler(req, res); return { ...res, body: res.text && res.headers['content-type']?.includes('json') ? JSON.parse(res.text) : {} }; }
const cookie = response => response.headers['set-cookie'].split(';')[0];
const directory = t => { const path = mkdtempSync(join(tmpdir(), 'sss-s22-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const put = (s, item, type, actor, body = {}) => s.append(item, { type, actor, at: '2026-11-10T00:00:00.000Z', ...body }, { idem: `${type}:${s.events(item).length}` });
const problem = { problem: 'A problem', have: true, have_note: 'looked', verdict: 'build_needed' };
async function member(auth, handler, id) {
  await auth.createUser(id, password, false);
  const response = await call(handler, 'POST', '/api/login', { id, password });
  return { cookie: cookie(response), origin: 'https://localhost', 'x-csrf-token': response.body.csrf };
}

// B13: the worker reads only the items in SENDING, found through the item cache.
test('worker reads only SENDING items on a pass, not every item in the database', () => {
  const store = new Store();
  store.registerPerson('s'); store.registerPerson('l', { leader: true });
  for (let n = 0; n < 499; n += 1) put(store, `idle-${n}`, 'checked', 's', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' });
  put(store, 'live', 'checked', 's', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' });
  put(store, 'live', 'specced', 's', { must: ['x'], how_we_know: ['yes'], out_of_scope: [] });
  put(store, 'live', 'approved', 'l', { spec_hash: store.read('live').context.specHash, cap_usd: 0, quorum: 1 });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM items WHERE state='SENDING'").get().n, 1);
  const reads = []; const read = store.read.bind(store);
  store.read = item => { reads.push(item); return read(item); };
  new Worker(store).reconcile();
  assert.ok(reads.length > 0);
  assert.deepEqual([...new Set(reads)], ['live']);
});

// B13: lock contention is a 503 with Retry-After, never the same words as a rule refusal.
test('lock contention answers 503 with Retry-After and is not worded as a refusal', async t => {
  const file = join(directory(t), 'db.sqlite');
  const store = new Store(file, { busyMs: 50 });
  const auth = new Auth(store); const handler = createHandler({ store, auth });
  const headers = await member(auth, handler, 'one');
  const made = await call(handler, 'POST', '/api/items', problem, headers);
  assert.equal(made.status, 201);
  const other = new DatabaseSync(file);
  other.exec('BEGIN IMMEDIATE');
  let busy;
  try {
    busy = await call(handler, 'POST', `/api/items/${made.body.id}/events`, { type: 'commented', comment: 'hello' }, headers);
  } finally { other.exec('ROLLBACK'); other.close(); }
  assert.equal(busy.status, 503);
  assert.equal(busy.headers['retry-after'], '1');
  assert.notEqual(busy.body.error, 'request refused');
  assert.match(busy.body.error, /busy/);
  const again = await call(handler, 'POST', `/api/items/${made.body.id}/events`, { type: 'commented', comment: 'hello' }, headers);
  assert.equal(again.status, 201);
  store.close();
});

// B12: the feed and the item API are paged at a fixed size, and the feed reads only one page.
test('feed and item API are paged at a fixed size and the feed reads one page of items', async () => {
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth });
  const headers = await member(auth, handler, 'one');
  store.registerPerson('author');
  for (let n = 0; n < 2000; n += 1) put(store, `item-${String(n).padStart(4, '0')}`, 'checked', 'author', { problem: `problem ${n}`, looked: ['x'], found: [], verdict: 'build_needed' });
  const reads = []; const events = store.events.bind(store);
  store.events = item => { reads.push(item); return events(item); };
  const feed = await call(handler, 'GET', '/', undefined, headers);
  assert.equal(feed.status, 200);
  assert.ok(reads.length <= 50, `feed read ${reads.length} items`);
  assert.equal((feed.text.match(/<li><a href="\/items\//g) || []).length, 50);
  const next = feed.text.match(/href="\/\?after=([^"]+)"/);
  assert.ok(next, 'feed links to the next page');
  const second = await call(handler, 'GET', `/?after=${next[1]}`, undefined, headers);
  assert.equal((second.text.match(/<li><a href="\/items\//g) || []).length, 50);
  assert.doesNotMatch(second.text, /href="\/items\/item-0049"/);
  const api = await call(handler, 'GET', '/api/items', undefined, headers);
  assert.equal(api.body.items.length, 50);
  assert.equal(typeof api.body.next, 'string');
  const apiSecond = await call(handler, 'GET', `/api/items?after=${encodeURIComponent(api.body.next)}`, undefined, headers);
  assert.equal(apiSecond.body.items.length, 50);
  assert.notEqual(apiSecond.body.items[0].id, api.body.items[0].id);
  store.close();
});

// B12: a member gets 60 writes a minute, the 61st is 429, and another member is not affected.
test('a member gets 60 writes a minute and the 61st is refused with 429', async () => {
  let now = 1_000_000;
  const store = new Store(); const auth = new Auth(store);
  const handler = createHandler({ store, auth, clock: () => now });
  const one = await member(auth, handler, 'one'); const two = await member(auth, handler, 'two');
  for (let n = 0; n < 60; n += 1) assert.equal((await call(handler, 'POST', '/api/items', problem, one)).status, 201, `write ${n + 1}`);
  assert.equal((await call(handler, 'POST', '/api/items', problem, one)).status, 429);
  assert.equal((await call(handler, 'POST', '/api/items', problem, two)).status, 201);
  now += 60_000;
  assert.equal((await call(handler, 'POST', '/api/items', problem, one)).status, 201);
  store.close();
});

// B12: one event is capped at 16 KB (413), and one item at 200 events (429).
test('an event over 16 KB is 413 and an item at 200 events is 429', async () => {
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth });
  const headers = await member(auth, handler, 'one'); store.registerPerson('author');
  const made = await call(handler, 'POST', '/api/items', problem, headers);
  const events = `/api/items/${made.body.id}/events`;
  assert.equal((await call(handler, 'POST', '/api/items', { ...problem, padding: 'x'.repeat(17 * 1024) }, headers)).status, 413);
  assert.equal((await call(handler, 'POST', events, { type: 'commented', comment: 'ok', padding: 'x'.repeat(17 * 1024) }, headers)).status, 413);
  assert.equal((await call(handler, 'POST', events, { type: 'commented', comment: 'ok', padding: 'x'.repeat(301 * 1024) }, headers)).status, 413);
  for (let n = 1; n < 200; n += 1) put(store, made.body.id, 'commented', 'author', { comment: `note ${n}` });
  assert.equal(store.events(made.body.id).length, 200);
  assert.equal((await call(handler, 'POST', events, { type: 'commented', comment: 'one more' }, headers)).status, 429);
  store.close();
});

// B12: gateway receipts are verified once for the whole item page, not once per item.
test('the item API verifies gateway receipts once per request', async t => {
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth });
  const headers = await member(auth, handler, 'one');
  for (let n = 0; n < 5; n += 1) assert.equal((await call(handler, 'POST', '/api/items', problem, headers)).status, 201);
  let verifications = 0; const receipts = Ledger.prototype.receipts;
  Ledger.prototype.receipts = function count() { verifications += 1; return receipts.call(this); };
  t.after(() => { Ledger.prototype.receipts = receipts; });
  const api = await call(handler, 'GET', '/api/items', undefined, headers);
  assert.equal(api.status, 200);
  assert.equal(api.body.items.length, 5);
  assert.equal(verifications, 1);
  store.close();
});

// B13: real child processes (handler, worker, watchdog, backup) share one database for 20 seconds.
const SOAK_MS = 20_000;
const child = new URL('./helpers/soak-child.mjs', import.meta.url).pathname;
function runChild(role, file, dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [child, role, file, String(SOAK_MS), dir],
      { env: { ...process.env, SOAK_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), SOAK_MS + 90_000);
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('exit', code => {
      clearTimeout(timer);
      let stats = null;
      try { stats = JSON.parse(out.trim().split('\n').at(-1)); } catch { /* reported as a failed child below */ }
      resolve({ role, code, stats, err });
    });
  });
}
test('soak: handler, worker, watchdog and backup processes run 20 seconds with no surfaced lock errors and a clean verify', async t => {
  const dir = directory(t); const file = join(dir, 'db.sqlite');
  const store = new Store(file); const auth = new Auth(store);
  for (let n = 0; n < 4; n += 1) await auth.createUser(`member${n}`, password, false);
  store.close();
  const results = await Promise.all(['handler', 'worker', 'watchdog', 'backup'].map(role => runChild(role, file, dir)));
  for (const result of results) {
    assert.equal(result.code, 0, `${result.role} exited ${result.code}: ${result.err.slice(0, 500)}`);
    assert.ok(result.stats, `${result.role} reported no stats`);
    assert.equal(result.stats.lockErrors, 0, `${result.role}: ${result.stats.firstError}`);
    assert.equal(result.stats.busy, 0, `${result.role}: ${result.stats.firstError}`);
    assert.equal(result.stats.stopped, false, `${result.role} stopped the install`);
    assert.ok(result.stats.ops > 0, `${result.role} did no work`);
  }
  assert.ok(results[0].stats.ok > 0, 'the handler accepted writes');
  const after = new Store(file);
  assert.equal(after.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const rows = after.verifyAll();
  assert.ok(rows.length >= results[0].stats.ok);
  assert.ok(rows.every(row => row.ok), JSON.stringify(rows.filter(row => !row.ok).slice(0, 3)));
  assert.equal(killed(after), false);
  after.close();
});
