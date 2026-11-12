import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('integration intake refuses forged, stale, replayed, oversized, unknown, and malformed input', async () => {
  let now = 1_000_000; const store = new Store(); const auth = new Auth(store);
  const integrations = new Integrations(store, { clock: () => now }); integrations.addSource('slack', secret);
  const handler = createHandler({ store, auth, integrations, secure: false, origin: 'http://127.0.0.1' });
  const send = (body, extra = {}) => request(handler, '/api/integrations/inbound/slack', { 'x-sss-timestamp': String(now), 'x-sss-signature': `sha256=${hmac(secret, String(now), body)}`, 'idempotency-key': 'one', ...extra }, body);
  assert.equal((await send(inbound())).status, 201);
  assert.equal(store.listItems()[0].state, 'SEEN');
  assert.equal((await send(inbound())).status, 409);
  assert.equal((await request(handler, '/api/integrations/inbound/missing', { 'x-sss-timestamp': String(now), 'x-sss-signature': `sha256=${hmac(secret, String(now), inbound())}`, 'idempotency-key': 'x' }, inbound())).status, 409);
  assert.equal((await send(inbound(), { 'x-sss-signature': 'sha256=bad', 'idempotency-key': 'two' })).status, 409);
  now += 5 * 60_000 + 1;
  const stale = inbound();
  assert.equal((await request(handler, '/api/integrations/inbound/slack', { 'x-sss-timestamp': '1000000', 'x-sss-signature': `sha256=${hmac(secret, '1000000', stale)}`, 'idempotency-key': 'three' }, stale)).status, 409);
  now = 1_000_000;
  const authority = Buffer.from(JSON.stringify({ problem: 'x', source_label: 'x', honesty_label: 'reported', actor: 'leader' }));
  assert.equal((await send(authority, { 'idempotency-key': 'four' })).status, 409);
  assert.equal((await send(Buffer.from('{'), { 'idempotency-key': 'five' })).status, 409);
  const huge = Buffer.alloc(16 * 1024 + 1, 120);
  assert.equal((await send(huge, { 'idempotency-key': 'six' })).status, 400);
});

test('integration intake has no workflow authority', () => {
  const store = new Store(); const integrations = new Integrations(store, { clock: () => 1_000_000 }); integrations.addSource('tool', secret);
  const bytes = inbound(); integrations.receive('tool', '1000000', `sha256=${hmac(secret, '1000000', bytes)}`, bytes, { 'idempotency-key': 'only-seen' });
  const [id] = store.listItems().map(row => row.id);
  assert.equal(store.read(id).state, 'SEEN');
  assert.throws(() => store.append(id, { type: 'checked', actor: 'source:tool', problem: 'x', looked: ['x'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'checked' }), /not allowed/);
  assert.throws(() => store.append(id, { type: 'approved', actor: 'source:tool', cap_usd: 0, quorum: 1, spec_hash: 'x', at: new Date().toISOString() }, { idem: 'approved' }), /not allowed/);
  assert.throws(() => store.append(id, { type: 'helped', actor: 'source:tool', artifact_hash: 'x', at: new Date().toISOString() }, { idem: 'helped' }), /not allowed/);
  assert.equal(store.read(id).context.steward, null);
});

test('integration outbox retries, dead-letters, and survives a restart', async t => {
  let now = 1_000_000; const directory = mkdtempSync(join(tmpdir(), 'sss-s13-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite'); let hits = 0; let received;
  const receiver = async (_url, options) => { hits += 1; received = { body: options.body, timestamp: options.headers['x-sss-timestamp'], signature: options.headers['x-sss-signature'] }; const failing = JSON.parse(options.body).item_id === 'item2'; return { ok: hits !== 1 && !failing, status: hits === 1 || failing ? 500 : 204 }; };
  let store = new Store(file); let integrations = new Integrations(store, { clock: () => now, fetcher: receiver }); integrations.addDestination('receiver', 'http://127.0.0.1/test', secret, { allowLoopback: true }); store.registerPerson('person');
  store.append('item', { type: 'checked', actor: 'person', problem: 'private problem', looked: ['checked'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'event' });
  store.db.prepare('UPDATE integration_outbox SET next_at=?').run(now);
  assert.equal(integrations.outbox()[0].state, 'pending');
  await integrations.deliverOnce(); assert.equal(integrations.outbox()[0].state, 'pending');
  store.close(); store = new Store(file); now = 2_000_000; integrations = new Integrations(store, { clock: () => now, fetcher: receiver });
  await integrations.deliverOnce(); assert.equal(integrations.outbox()[0].state, 'delivered');
  assert.equal(hits, 2); assert.equal(JSON.parse(received.body).text, undefined); assert.equal(received.signature, `sha256=${hmac(secret, received.timestamp, Buffer.from(received.body))}`);
  // A permanently failing receiver becomes visible as a dead letter.
  store.registerPerson('other'); store.append('item2', { type: 'checked', actor: 'other', problem: 'x', looked: ['x'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'event2' });
  store.db.prepare('UPDATE integration_outbox SET next_at=? WHERE item=?').run(now, 'item2');
  for (let count = 0; count < 5; count += 1) { now += 10_000_000; await integrations.deliverOnce(); }
  assert.equal(integrations.outbox().find(row => row.item === 'item2').state, 'dead');
});

test('integration CLI never prints secrets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sss-s13-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true })); const env = { SSS_DB: join(directory, 'db.sqlite') }; const lines = [];
  await cli(['integration', 'source', 'add', '--name', 'safe', '--secret', secret], env, value => lines.push(value));
  await cli(['integration', 'source', 'list'], env, value => lines.push(value));
  assert.equal(lines.join('\n').includes(secret), false);
});
