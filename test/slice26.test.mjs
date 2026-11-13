import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store.js';
import { Integrations } from '../app/integrations.js';
import { localCommand } from '../provider/adapters.js';
import * as safe from '../provider/safe-http.js';
import * as config from '../provider/config.js';

// Documentation-only names (RFC 2606 and RFC 6761) keep the sandbox from ever meaning a real host.
// The address 93.184.216.34 is a public address; it is never dialed because every connector here is injected.
const PUBLIC = '93.184.216.34';
const PRIVATE = '10.0.0.5';
const request = { system: 'S', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 2, model: 'm' };
const completion = { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const answer = body => ({ ok: true, status: 200, body: new Response(JSON.stringify(body)).body });
// Each call to the resolver returns the next answer set; the last one repeats.
const flipping = (...sets) => {
  const calls = [];
  const resolver = async host => { calls.push(host); return sets[Math.min(calls.length, sets.length) - 1].map(address => ({ address })); };
  return { resolver, calls };
};

test('egress dials the address that passed the check, never a second answer', async () => {
  const { resolver, calls } = flipping([PUBLIC], [PRIVATE]);
  const dialed = [];
  const connector = async (url, init) => { dialed.push({ host: url.hostname, address: init.address }); return answer(completion); };
  const body = await safe.jsonRequest('https://provider.test/v1/chat', { hosts: ['provider.test'], body: { x: 1 }, resolver, connector });
  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(dialed, [{ host: 'provider.test', address: PUBLIC }]);
  assert.deepEqual(calls, ['provider.test']);
});

test('one reserved answer in the set refuses the whole request and dials nothing', async () => {
  const { resolver } = flipping([PUBLIC, PRIVATE]);
  let dialed = 0;
  const connector = async () => { dialed += 1; return answer(completion); };
  await assert.rejects(() => safe.jsonRequest('https://provider.test/v1/chat', { hosts: ['provider.test'], body: {}, resolver, connector }), /private provider address refused/);
  assert.equal(dialed, 0);
});

test('the reserved table covers every range the plan names', () => {
  const reserved = [
    '0.0.0.0', '0.1.2.3', '10.1.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '100.100.100.100', '100.127.255.254', // CGNAT (Tailscale's range)
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.51.100.5', '203.0.113.9',
    '198.18.0.1', '198.19.255.254', // benchmark
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:10.0.0.5', '::ffff:169.254.169.254', '::ffff:100.64.0.1', '::ffff:127.0.0.1',
    '64:ff9b::a00:5', '100::1', '2001:db8::1', '2001:10::1', '2002:c000:201::1', '3fff::1',
    'fe80::1', 'fc00::1', 'fd12:3456::5', 'ff02::1',
  ];
  for (const ip of reserved) assert.equal(safe.addressIsReserved(ip), true, `${ip} must be reserved`);
  const public_ = ['93.184.216.34', '8.8.8.8', '100.63.255.255', '100.128.0.0', '198.17.255.255', '198.20.0.0',
    '::ffff:8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'];
  for (const ip of public_) assert.equal(safe.addressIsReserved(ip), false, `${ip} must not be reserved`);
});

test('an IPv6 literal host is checked as a literal and refused when reserved', async () => {
  await assert.rejects(() => safe.resolvePinned('https://[fd00::5]/v1', { hosts: ['[fd00::5]'] }), /private provider address refused/);
  const pin = await safe.resolvePinned('https://[2606:4700:4700::1111]/v1', { hosts: ['[2606:4700:4700::1111]'], resolver: async () => assert.fail('a literal needs no lookup') });
  assert.equal(pin.address, '2606:4700:4700::1111');
});

test('the default connector looks up only the pinned address', async () => {
  // Port 1 on loopback refuses instantly. With the pin, the connector reaches loopback and gets ECONNREFUSED;
  // without it, the name pinned.test would go through DNS and fail with a different code.
  await assert.rejects(() => safe.pinnedFetch(new URL('http://pinned.test:1/'), { address: '127.0.0.1', method: 'POST', headers: {}, body: '{}' }), { code: 'ECONNREFUSED' });
});

test('the providers file lives beside the database by default', () => {
  assert.equal(config.configPath({ SSS_DB: '/srv/see/data/sss.db' }), '/srv/see/data/sss.providers.json');
  assert.equal(config.configPath({ SSS_DB: '/srv/see/data/sss.db', SSS_PROVIDERS_FILE: '/etc/see/p.json' }), '/etc/see/p.json');
});

test('a providers or key file that others can write, or that another user owns, is refused', () => {
  const stat = (mode, uid = 1000) => ({ mode: 0o100000 | mode, uid, isFile: () => true });
  for (const mode of [0o666, 0o662, 0o620, 0o777]) assert.throws(() => config.assertOwnerOnly(stat(mode), 1000), /writable/, `mode ${mode.toString(8)}`);
  assert.throws(() => config.assertOwnerOnly(stat(0o600, 0), 1000), /owned/);
  for (const mode of [0o600, 0o640, 0o400]) assert.doesNotThrow(() => config.assertOwnerOnly(stat(mode), 1000), `mode ${mode.toString(8)}`);
});

test('a writable providers file is refused on read and the database directory is used by default', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-slice26-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sss.providers.json');
  writeFileSync(file, JSON.stringify({ providers: [], defaults: {} })); chmodSync(file, 0o666);
  assert.throws(() => config.readProviders({ SSS_DB: join(dir, 'sss.db') }), /writable/);
  chmodSync(file, 0o600);
  assert.deepEqual(config.readProviders({ SSS_DB: join(dir, 'sss.db') }).providers, []);
});

test('a writable API key file is refused when the provider is used', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-slice26-key-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { SSS_PROVIDERS_FILE: join(dir, 'sss.providers.json') };
  const key = join(dir, 'key.txt'); writeFileSync(key, 'sk-test-not-real-0001'); chmodSync(key, 0o666);
  config.saveProviders({ providers: [{ name: 'remote', kind: 'openai', model: 'm', enabled: true, url: 'https://api.provider.test/v1/chat',
    hosts: ['api.provider.test'], apiKeyFile: key, price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } }], defaults: {} }, env);
  assert.throws(() => config.providerFor('remote', env), /writable/);
  chmodSync(key, 0o600);
  assert.equal(typeof config.providerFor('remote', env).complete, 'function');
});

test('the local command adapter stops its child when the request signal aborts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-slice26-abort-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slow = join(dir, 'slow.mjs'); writeFileSync(slow, 'setTimeout(() => {}, 5000)');
  const controller = new AbortController();
  const started = Date.now();
  const pending = localCommand({ command: [process.execPath, slow] }).complete({ ...request, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /aborted/);
  assert.ok(Date.now() - started < 2000, 'the child is killed at abort, not after it exits');
});

test('outbox delivery dials the address it checked, and asks the resolver once', async () => {
  const store = new Store(); const now = 1_000_000;
  store.db.prepare("INSERT INTO integration_destinations(name,url,secret,include_text,enabled,allow_loopback) VALUES('hook','https://hooks.provider.test/in','this-is-a-long-test-secret',0,1,0)").run();
  store.db.prepare("INSERT INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created) VALUES('hook','i',1,'checked','CHECKED','{}','pending',0,?,?)").run(now, now);
  const { resolver, calls } = flipping([PUBLIC], [PRIVATE]);
  const dialed = [];
  const fetcher = async (url, init) => { dialed.push({ host: url.hostname, address: init.address }); return { ok: true, status: 200 }; };
  const integrations = new Integrations(store, { clock: () => now, fetcher, resolver });
  assert.equal(await integrations.deliverOnce(), true);
  assert.deepEqual(dialed, [{ host: 'hooks.provider.test', address: PUBLIC }]);
  assert.deepEqual(calls, ['hooks.provider.test']);
  assert.equal(store.db.prepare('SELECT state FROM integration_outbox').get().state, 'delivered');
  store.close();
});
