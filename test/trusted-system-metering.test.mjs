import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveProviders } from '../provider/config.js';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { completedQuest } from './helpers/quest-fixture.mjs';
import { deriveQuest } from '../public/vision-quest.js';
import { Ledger, fixturePolicy, fixtureRates, rateWithSystemText } from '../gateway/ledger.js';
import { providerGateway } from '../gateway/http.js';
import { QuestGateway } from '../gateway/quest.js';
import { EffortGateway } from '../gateway/effort.js';
import { SYSTEM_PROMPT } from '../worker/builder/index.js';
import { EFFORT_SYSTEM } from '../effort/prompt.js';
import { SPEC_INSTRUCTIONS } from '../effort/spec.js';
import { QUEST_SYSTEM } from '../provider/vision-quest.js';
import { fixture, request } from './helpers/gateway-fixture.mjs';

const input = request({ input: '{}', max_output_tokens: 1 });
const providerResult = n => ({ output: 'ok', usage: { input_tokens: n, output_tokens: 1 } });

test('builder reserves trusted system bytes before dispatch and snapshots its rate', async () => {
  const { store, ledger, token } = fixture();
  try {
    const n = Buffer.byteLength(input.input) + Buffer.byteLength(SYSTEM_PROMPT);
    const gateway = providerGateway(ledger, { complete: async () => ({ text: 'ok', usage: { inputTokens: n, outputTokens: 1 } }) }, { system: SYSTEM_PROMPT });
    assert.equal((await gateway.call(token, 'builder-system', input)).status, 200);
    const row = ledger.receipts()[0];
    assert.equal(row.input_bound, n + fixtureRates.framing_tokens);
    assert.equal(JSON.parse(row.rate).framing_tokens, Buffer.byteLength(SYSTEM_PROMPT) + fixtureRates.framing_tokens);
    assert.equal(row.charged_micros, n + 2);
    assert.equal(ledger.rate.framing_tokens, fixtureRates.framing_tokens);
  } finally { store.close(); }
});

test('Effort and Quest system usage settles and failure holds the full adjusted reservation', async () => {
  for (const [kind, systems] of [['quest', [QUEST_SYSTEM]], ['effort', [EFFORT_SYSTEM, SPEC_INSTRUCTIONS]]]) {
    const store = new Store();
    try {
      const rate = rateWithSystemText(fixtureRates, ...systems);
      const ledger = new Ledger(store, { rate }); ledger.configure(fixturePolicy());
      const n = Buffer.byteLength(input.input) + Math.max(...systems.map(s => Buffer.byteLength(s)));
      const make = provider => kind === 'quest' ? new QuestGateway(ledger, provider) : new EffortGateway(ledger, provider);
      const call = (gateway, idem) => kind === 'quest' ? gateway.call('person', idem, input) : gateway.call('person', idem, input, 'item', 'job');
      const gateway = make(async () => providerResult(n));
      assert.equal((await call(gateway, 'settled')).status, 200);
      assert.equal(gateway.receipts()[0].charged_micros, n + 2);
      const failure = make(async () => { throw Error('unknown provider usage'); });
      assert.equal((await call(failure, 'hold')).status, 202);
      const hold = failure.receipts().find(row => row.state === 'dispatched');
      assert.equal(hold.input_bound, n + fixtureRates.framing_tokens);
      assert.equal(hold.charged_micros, hold.worst_micros);
      ledger.setPolicy(fixturePolicy({ global_micros: hold.charged_micros, day_micros: 100000 }));
      let calls = 0;
      await assert.rejects(call(make(async () => { calls++; return providerResult(n); }), 'cap'), /global cap exceeded/);
      assert.equal(calls, 0);
    } finally { store.close(); }
  }
});

test('empty systems preserve fixture bounds and invalid or overflowing adjustments fail', () => {
  assert.deepEqual(rateWithSystemText(fixtureRates, ''), fixtureRates);
  assert.throws(() => rateWithSystemText(fixtureRates, null), /invalid trusted system/);
  assert.throws(() => rateWithSystemText({ ...fixtureRates, framing_tokens: Number.MAX_SAFE_INTEGER }, 'x'), /unsafe accounting/);
});

test('real serve CLI reserves Effort system text before the loopback provider call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-system-metering-'));
  const db = join(dir, 'db');
  const env = { ...process.env, SSS_DB: db, SSS_PROVIDERS_FILE: join(dir, 'providers.json'), SSS_TEST_KEY: 'synthetic-key' };
  let observed;
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find(message => message.role === 'system').content;
    const user = body.messages.find(message => message.role === 'user').content;
    observed = { system, user, tokens: Buffer.byteLength(system) + Buffer.byteLength(user) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Check the handoff.' } }],
      usage: { prompt_tokens: observed.tokens, completion_tokens: 1 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  saveProviders({ providers: [{ name: 'mock', kind: 'openai', model: 'mock-model', enabled: true,
    url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`, hosts: ['127.0.0.1'], allowPrivate: true,
    apiKeyEnv: 'SSS_TEST_KEY', price: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 } }], defaults: { default: 'mock' } }, env);
  const store = new Store(db);
  store.registerPerson('op');
  store.append('metering', { type: 'posted', actor: 'op', original: 'Callers lose context.', rules: 2, at: new Date().toISOString() }, { idem: 'seed' });
  new Ledger(store).configure(fixturePolicy());
  let log = '';
  const child = spawn(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'serve', '--port', '0', '--insecure-cookies', '--enable-effort'], { env });
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    store.close(); await new Promise(resolve => upstream.close(resolve)); rmSync(dir, { recursive: true, force: true });
  });
  let row;
  for (let i = 0; i < 80; i++) {
    row = store.db.prepare('SELECT * FROM gateway_effort_receipts LIMIT 1').get();
    if (row?.state === 'settled' || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(row?.state, 'settled', `CLI did not settle a receipt: ${log}`);
  assert.equal(observed.system, EFFORT_SYSTEM);
  assert.ok(observed.tokens > Buffer.byteLength(observed.user) + 8);
  assert.ok(row.input_bound >= Buffer.byteLength(observed.user) + Math.max(Buffer.byteLength(EFFORT_SYSTEM), Buffer.byteLength(SPEC_INSTRUCTIONS)));
  assert.equal(row.charged_micros, observed.tokens + 2);
});

test('real serve CLI reserves Quest system text for an authenticated draft', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-quest-metering-'));
  const db = join(dir, 'db');
  const env = { ...process.env, SSS_DB: db, SSS_PROVIDERS_FILE: join(dir, 'providers.json'), SSS_TEST_KEY: 'synthetic-key' };
  const quest = completedQuest();
  let observed;
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find(message => message.role === 'system').content;
    const user = body.messages.find(message => message.role === 'user').content;
    observed = { system, user, tokens: Buffer.byteLength(system) + Buffer.byteLength(user) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memo: deriveQuest(quest) }) } }],
      usage: { prompt_tokens: observed.tokens, completion_tokens: 1 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  saveProviders({ providers: [{ name: 'mock', kind: 'openai', model: 'mock-model', enabled: true,
    url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`, hosts: ['127.0.0.1'], allowPrivate: true,
    apiKeyEnv: 'SSS_TEST_KEY', price: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 } }], defaults: { default: 'mock' } }, env);
  const store = new Store(db);
  await new Auth(store).createUser('maker', 'synthetic-long-passphrase-7', false);
  new Ledger(store).configure(fixturePolicy());
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'serve', '--port', String(port), '--origin', origin,
    '--insecure-cookies', '--enable-quest-model', '--quest-provider', 'mock'], { env });
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    store.close(); await new Promise(resolve => upstream.close(resolve)); rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 80 && !log.includes('Serving '); i++) {
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(log, /Serving /, `CLI did not start: ${log}`);
  const post = (path, payload, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(payload) });
  const login = await post('/api/login', { id: 'maker', password: 'synthetic-long-passphrase-7' });
  assert.equal(login.status, 200);
  const csrf = (await login.json()).csrf;
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': csrf, 'idempotency-key': 'quest-metering' };
  const input = { quest, max_output_tokens: 256 };
  const preflight = await post('/api/quest/model/preflight', input, headers);
  assert.equal(preflight.status, 200, await preflight.text());
  assert.equal(store.listItems().length, 0);
  const draft = await post('/api/quest/model/draft', input, headers);
  assert.equal(draft.status, 200, await draft.text());
  const receipt = store.db.prepare('SELECT * FROM gateway_quest_receipts').get();
  assert.equal(receipt?.state, 'settled');
  assert.equal(observed.system, QUEST_SYSTEM);
  assert.ok(observed.tokens > Buffer.byteLength(observed.user) + 8);
  assert.ok(receipt.input_bound >= observed.tokens);
  assert.equal(receipt.charged_micros, observed.tokens + 2);
  assert.equal(store.listItems().length, 0, 'model draft must not create workflow state');
});
