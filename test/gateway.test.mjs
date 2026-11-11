import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { FakeAdapter } from '../worker/fake.js';
import { setKill } from '../worker/control.js';
import { Ledger, fixturePolicy, digest, canonical } from '../gateway/ledger.js';
import { Gateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider } from '../gateway/fixture.js';
import { Auth } from '../app/auth.js';
import { createServerFor } from '../app/http.js';
import { main } from '../cli.js';
import { fixture, request, usage, put, spec, approve } from './helpers/gateway-fixture.mjs';

const directory = t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-gateway-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'db');
};
const local = async (t, server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
};
const post = (url, token, idem, input = request()) => fetch(`${url}/v1/generate`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
    'idempotency-key': idem }, body: JSON.stringify(input),
});
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// The server, parser, bearer gate and mocked provider are exercised through real localhost HTTP.
test('gateway HTTP settles exact integer micros and persists only credential digests', async t => {
  const { store, ledger, token, run } = fixture(); t.after(() => store.close());
  let calls = 0;
  const server = createGatewayServer(new Gateway(ledger, (input, context) => {
    calls++;
    assert.deepEqual(Object.keys(context), ['id']);
    assert.equal(JSON.stringify(input).includes(token), false);
    return fixtureProvider(input);
  }));
  const url = await local(t, server);
  const first = await post(url, token, 'same');
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.equal(receipt.estimated_micros, 15);
  assert.equal((await post(url, token, 'same')).status, 200);
  assert.equal(calls, 1);
  const row = ledger.receipts()[0];
  assert.equal(row.worst_micros, 33);
  assert.equal(row.cap_micros, 100_000);
  assert.equal(row.spec_hash, run.spec_hash);
  assert.equal(row.payload_hash, digest(canonical(request())));
  assert.equal(JSON.parse(row.rate).framing_tokens, 8);
  assert.equal(row.approval, 1);
  assert.ok(row.approval_hash);
  for (const table of ['gateway_capabilities', 'gateway_receipts', 'fake_jobs', 'events', 'bodies', 'actors']) {
    assert.equal(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes(token), false, table);
  }
  assert.equal(store.db.prepare('SELECT 1 FROM actors WHERE id=?').get(digest(token)), undefined);
  assert.equal(store.read('item').context.spentMicros, 0);
  assert.equal(ledger.summary('item').approvals[0].settled_micros, 15);
  const conflict = await post(url, token, 'same', request({ input: 'changed' }));
  assert.equal(conflict.status, 400); assert.equal(calls, 1);
});

test('100 barrier HTTP calls one cent below cap never forward refused reservations', async t => {
  const { store, ledger, token, run } = fixture(':memory:', {
    output_tokens: 10_000, global_micros: 1_000_000, day_micros: 1_000_000, concurrency: 100,
  }, 0.02);
  t.after(() => store.close());
  put(store, 'charged', run.gateway_actor, { approval: 1, spec_hash: run.spec_hash, usd: 0.01 });
  const barrier = pending(); const provider = pending();
  let entered = 0; let forwarded = 0;
  const gateway = new Gateway(ledger, async input => { forwarded++; await provider.promise; return usage(input); });
  const original = gateway.call.bind(gateway);
  gateway.call = async (...args) => { if (++entered === 100) barrier.resolve(); await barrier.promise; return original(...args); };
  const url = await local(t, createGatewayServer(gateway));
  const input = request({ input: 'xx', max_output_tokens: 4995 });
  const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => post(url, token, `barrier:${i}`, input)));
  assert.equal(entered, 100);
  assert.equal(forwarded, 1);
  assert.equal(responses.filter(res => res.status === 402).length, 99);
  assert.equal(responses.filter(res => res.status === 202).length, 1);
  const rows = ledger.receipts();
  assert.equal(rows.length, 1);
  assert.equal(rows.reduce((sum, row) => sum + row.worst_micros, 0), 10_000);
  provider.resolve();
  await new Promise(resolve => setImmediate(resolve));
});

test('concurrent duplicates get one outcome or honest unresolved hold without redispatch', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const waiting = pending(); let calls = 0;
  const url = await local(t, createGatewayServer(new Gateway(ledger, async input => {
    calls++; await waiting.promise; return usage(input);
  })));
  const responses = await Promise.all(Array.from({ length: 20 }, () => post(url, token, 'duplicate')));
  assert.equal(calls, 1);
  assert.ok(responses.every(response => response.status === 202));
  assert.equal(ledger.receipts().length, 1);
  waiting.resolve(); await new Promise(resolve => setImmediate(resolve));
  const completed = await post(url, token, 'duplicate');
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).estimated_micros, 15);
  assert.equal(calls, 1);
});

test('two actual SQLite writers contend on one worst-case allowance', async t => {
  const file = directory(t);
  const { store, ledger, token } = fixture(file, { concurrency: 100 }, 0.000033);
  t.after(() => store.close());
  const module = new URL('../gateway/ledger.js', import.meta.url).href;
  const storeModule = new URL('../core/store.js', import.meta.url).href;
  const code = `import {Store} from '${storeModule}';import {Ledger} from '${module}';
    const s=new Store(process.argv[1]);const l=new Ledger(s);process.send('ready');
    process.on('message',m=>{if(m==='go'){let n=0;for(let i=0;i<50;i++){
      try{l.reserve(process.argv[2],process.argv[3]+i,${JSON.stringify(request())});n++}catch{}}
      process.send(n);s.close();process.disconnect();}});`;
  const writers = ['a', 'b'].map(id => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, file, token, id],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; p.stderr.on('data', bytes => { errors += bytes; });
    const ready = new Promise(resolve => p.once('message', resolve));
    const done = new Promise((resolve, reject) => { p.on('error', reject); p.on('close', code => {
      if (code !== 0) reject(new Error(errors)); else resolve();
    }); });
    return { p, ready, done };
  });
  await Promise.all(writers.map(writer => writer.ready));
  for (const writer of writers) writer.p.send('go');
  await Promise.all(writers.map(writer => writer.done));
  assert.equal(ledger.receipts().length, 1);
  assert.equal(ledger.receipts()[0].charged_micros, 33);
});

test('late usage settles the original approval after respec, new approval, kill and UTC rollover', async t => {
  let now = Date.parse('2026-11-10T23:59:59Z');
  const { store, ledger, token, run } = fixture(':memory:', { timeout_ms: 1 }, 0.1, { clock: () => now });
  t.after(() => store.close());
  const waiting = pending(); const gateway = new Gateway(ledger, () => waiting.promise);
  const result = await gateway.call(token, 'late', request()); assert.equal(result.status, 202);
  spec(store); approve(store, 0.2);
  class Waiting extends FakeAdapter { status() { return { state: 'running' }; } }
  new Worker(store, new Waiting(store)).reconcile();
  const fresh = store.db.prepare('SELECT * FROM runs WHERE approval=2').get();
  const freshToken = ledger.mint(fresh.id);
  assert.throws(() => ledger.reserve(token, 'forged', request()), /stopped|stale/);
  now += 2000;
  setKill(store, true);
  waiting.resolve(usage()); await new Promise(resolve => setImmediate(resolve));
  const row = ledger.receipts()[0];
  assert.equal(row.approval, run.approval);
  assert.equal(row.cap_micros, 100_000);
  assert.equal(row.day, '2026-11-10');
  assert.equal(row.charged_micros, 15); assert.equal(row.state, 'settled');
  assert.equal(store.read('item').context.spentMicros, 0);
  assert.equal(store.read('item').context.capMicros, 200_000);
  assert.throws(() => ledger.reserve(freshToken, 'blocked', request()), /stopped/);
});

test('ambiguous dispatch and pre-dispatch crash holds survive restart and never retry the provider', async t => {
  const file = directory(t);
  let { store, ledger, token } = fixture(file, { timeout_ms: 1, concurrency: 3 });
  const first = ledger.reserve(token, 'after', request()).row;
  assert.equal(ledger.dispatch(token, first.id), true);
  ledger.reserve(token, 'before', request());
  store.close(); store = new Store(file); t.after(() => store.close()); ledger = new Ledger(store);
  let called = 0; const gateway = new Gateway(ledger, () => { called++; return usage(); });
  assert.equal((await gateway.call(token, 'after', request())).status, 202);
  assert.equal((await gateway.call(token, 'before', request())).status, 202);
  assert.equal(called, 0);
  assert.equal(ledger.receipts().reduce((n, row) => n + row.charged_micros, 0), 66);
  assert.throws(() => ledger.configure(fixturePolicy({ global_micros: 999_999 })), /already fixed/);
  assert.equal(ledger.summary().approvals[0].unknown_micros, 33);
  assert.equal(ledger.summary().approvals[0].reserved_micros, 33);
});

test('missing, hostile, oversized and rejected usage holds worst case and concurrency', async t => {
  for (const response of [null, { output: 'x' }, { output: 'x', usage: { input_tokens: -1, output_tokens: 0 } },
    { output: 'x', usage: { input_tokens: 1, output_tokens: NaN } },
    { output: 'x', usage: { input_tokens: 1, output_tokens: Infinity } },
    { output: 'x', usage: { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER } },
    { output: 'x', usage: { input_tokens: 14, output_tokens: 1 } },
    { output: 'x', usage: { input_tokens: 1, output_tokens: 11 } },
    { output: 'x'.repeat(8193), usage: { input_tokens: 1, output_tokens: 1 } },
    { output: 'x', usage: { input_tokens: 1, output_tokens: 1, total_cost: 0 } }]) {
    const { store, ledger, token } = fixture(':memory:', { concurrency: 1 });
    try {
      const gateway = new Gateway(ledger, () => response);
      assert.equal((await gateway.call(token, 'bad', request())).status, 202);
      assert.equal(ledger.receipts()[0].charged_micros, 33);
      assert.throws(() => ledger.reserve(token, 'next', request()), /concurrency/);
    } finally { store.close(); }
  }
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  assert.equal((await new Gateway(ledger, () => { throw new Error('private provider key'); })
    .call(token, 'exception', request())).status, 202);
  assert.equal(ledger.receipts()[0].charged_micros, 33);
});

test('server validates hostile limits, model prices, payload keys, capability scope and expiry', async t => {
  let now = Date.now();
  const { store, ledger, token, run } = fixture(':memory:', {}, 0.1, { clock: () => now });
  t.after(() => store.close());
  let calls = 0;
  const url = await local(t, createGatewayServer(new Gateway(ledger, input => { calls++; return usage(input); })));
  const bad = [request({ model: 'unreviewed-real-model' }), request({ input: 'x'.repeat(8193) }),
    request({ max_output_tokens: -1 }), request({ max_output_tokens: 0 }), request({ max_output_tokens: 1.5 }),
    request({ max_output_tokens: '10' }), request({ max_output_tokens: 1025 }),
    request({ max_output_tokens: Number.MAX_SAFE_INTEGER }), request({ max_output_tokens: NaN }),
    request({ max_output_tokens: Infinity }), request({ role: 'leader' }), request({ cap_micros: 0 }),
    request({ input: null }), JSON.parse('{"__proto__":{"leader":true}}')];
  for (let i = 0; i < bad.length; i++) assert.equal((await post(url, token, `bad:${i}`, bad[i])).status, 400);
  assert.equal(calls, 0); assert.equal(ledger.receipts().length, 0);
  assert.equal((await post(url, 'x'.repeat(43), 'bad-token')).status, 403);
  assert.throws(() => store.append('item', { type: 'approved', actor: digest(token),
    at: new Date().toISOString(), spec_hash: run.spec_hash, cap_usd: 10, quorum: 1 }, { idem: 'cap-approval' }), /unknown actor/);
  assert.throws(() => put(store, 'helped', digest(token), { artifact_hash: 'x' }), /unknown actor/);
  ledger.revokeDigest(digest(token));
  assert.equal((await post(url, token, 'revoked')).status, 403);
  const expired = ledger.mint(run.id, 1); now += 1;
  assert.equal((await post(url, expired, 'expired')).status, 403);
  assert.equal(calls, 0);
});

test('global, daily, concurrency and combined legacy cap gates are independent', async t => {
  for (const [policy, message] of [
    [{ global_micros: 32 }, /global cap/], [{ day_micros: 32 }, /day cap/],
  ]) {
    const { store, ledger, token } = fixture(':memory:', policy);
    try { assert.throws(() => ledger.reserve(token, 'cap', request()), message); }
    finally { store.close(); }
  }
  const { store, ledger, token, run } = fixture(':memory:', {}, 0.00005); t.after(() => store.close());
  ledger.reserve(token, 'hold', request());
  assert.throws(() => put(store, 'charged', run.gateway_actor,
    { approval: 1, spec_hash: run.spec_hash, usd: 0.000018 }), /combined.*cap/);
  put(store, 'charged', run.gateway_actor, { approval: 1, spec_hash: run.spec_hash, usd: 0.000017 });
  assert.throws(() => ledger.reserve(token, 'new', request()), /run cap/);
});

test('default is disabled; corrupted receipts and policy refuse admission and status', async t => {
  const { store, token, run } = fixture(); t.after(() => store.close());
  const other = new Store(); t.after(() => other.close());
  assert.equal(new Ledger(other).policy().enabled, false);
  const ledger = new Ledger(store);
  ledger.reserve(token, 'held', request());
  store.db.prepare('UPDATE gateway_receipts SET charged_micros=0').run();
  assert.throws(() => ledger.reserve(token, 'new', request()), /corrupt/);
  assert.throws(() => ledger.summary(), /corrupt/);
  assert.throws(() => put(store, 'charged', run.gateway_actor,
    { approval: 1, spec_hash: run.spec_hash, usd: 0 }), /corrupt/);
  store.db.prepare("UPDATE gateway_policy SET bytes='{}'").run();
  assert.throws(() => ledger.policy(), /corrupt/);
});

test('CLI status and API budget expose original approval holds separately from legacy events', async t => {
  const file = directory(t); const { store, ledger, token } = fixture(file); t.after(() => store.close());
  ledger.reserve(token, 'held', request());
  const output = [];
  await main(['gateway', 'status'], { SSS_DB: file }, value => output.push(JSON.parse(value)));
  assert.match(output[0].basis, /estimates.*not provider invoices/);
  assert.equal(output[0].approvals[0].reserved_micros, 33);
  const auth = new Auth(store);
  // Creating only a session avoids password work unrelated to the read-only budget route.
  const session = auth.newSession('reader');
  const url = await local(t, createServerFor({ store, auth, secure: false, origin: 'http://127.0.0.1' }));
  const response = await fetch(`${url}/api/items/item`, { headers: { cookie: `sss=${session.value}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.spent_basis, /legacy/);
  assert.equal(body.gateway_budget.approvals[0].reserved_micros, 33);
  assert.equal(body.state.context.spentMicros, 0);
  await main(['gateway', 'revoke', '--digest', digest(token)], { SSS_DB: file }, () => {});
  assert.throws(() => ledger.reserve(token, 'revoked', request()), /revoked/);
});
