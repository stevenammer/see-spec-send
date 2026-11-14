import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { QuestGateway } from '../gateway/quest.js';
import { setKill } from '../worker/control.js';
import { fixture, request } from './helpers/gateway-fixture.mjs';
import { main } from '../cli.js';

async function call(handler, path, input, headers) {
  const req = Readable.from([JSON.stringify(input)]);
  req.method = 'POST'; req.url = path;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { headers: {}, text: '', status: 200, setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, values = {}) { this.status = status; Object.assign(this.headers, values); },
    end(value = '') { this.text += value; } };
  await handler(req, res); return { ...res, json: res.text ? JSON.parse(res.text) : null };
}

test('Quest model routes are opt-in, and an enabled route uses the metered gateway', async () => {
  const store = new Store(); const auth = new Auth(store);
  try {
    await auth.createUser('member', 'synthetic-long-passphrase-7');
    const login = await call(createHandler({ store, auth }), '/api/login', { id: 'member', password: 'synthetic-long-passphrase-7' }, {});
    const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://localhost', 'x-csrf-token': login.json.csrf };
    const input = { provider: 'fake', quest: {}, max_output_tokens: 1 };
    const disabled = createHandler({ store, auth });
    assert.equal((await call(disabled, '/api/quest/model/preflight', input, headers)).status, 404);
    assert.equal((await call(disabled, '/api/quest/model/draft', input, headers)).status, 404);
    let calls = 0;
    const enabled = createHandler({ store, auth, questModel: { preflight: () => ({ ok: true }),
      draft: async person => { calls++; return { person, ok: true }; } } });
    const result = await call(enabled, '/api/quest/model/draft', input, headers);
    assert.equal(result.status, 200); assert.equal(result.json.person, 'member'); assert.equal(calls, 1);
  } finally { store.close(); }
});

test('Quest gateway refuses kill, ceiling and per-person budget before calling its provider, and seals counted rows', async () => {
  let now = Date.parse('2026-11-12T12:00:00Z'); const store = new Store();
  try {
    const ledger = new Ledger(store, { clock: () => now }); ledger.configure(fixturePolicy({ global_micros: 1000, day_micros: 1000 }));
    let calls = 0; const gateway = new QuestGateway(ledger, async input => { calls++; return { output: 'ok', usage: { input_tokens: Buffer.byteLength(input.input), output_tokens: 1 } }; }, { clock: () => now });
    await assert.rejects(gateway.call('member', 'too-many', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 257 }), /output token limit/);
    setKill(store, true);
    await assert.rejects(gateway.call('member', 'stopped', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }), /stopped/);
    setKill(store, false);
    for (let n = 0; n < 3; n++) await gateway.call('member', `ok:${n}`, { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 });
    await assert.rejects(gateway.call('member', 'over', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }), /person daily call limit/);
    assert.equal(calls, 3); assert.equal(gateway.receipts().length, 3);
    assert.ok(gateway.receipts().every(row => row.seal && row.state === 'settled'));
    const tightLedger = new Ledger(store, { clock: () => now });
    tightLedger.setPolicy(fixturePolicy({ global_micros: 1000, day_micros: 10 }));
    const tight = new QuestGateway(tightLedger, async () => { calls++; return { output: 'never', usage: { input_tokens: 1, output_tokens: 1 } }; }, { clock: () => now });
    await assert.rejects(tight.call('other', 'day-cap', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }), /day cap exceeded/);
    assert.equal(calls, 3);

    const globalStore = new Store(); const globalLedger = new Ledger(globalStore, { clock: () => now });
    globalLedger.configure(fixturePolicy({ global_micros: 10, day_micros: 1000 }));
    const globallyCapped = new QuestGateway(globalLedger, async () => { calls++; return { output: 'never', usage: { input_tokens: 1, output_tokens: 1 } }; }, { clock: () => now });
    await assert.rejects(globallyCapped.call('global', 'lifetime-cap', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }), /global cap exceeded/);
    globalStore.close();

    const personStore = new Store(); const costlyLedger = new Ledger(personStore, { clock: () => now,
      rate: { model: 'fixture:text-v1', input_micros: 20_000, output_micros: 20_000, framing_tokens: 8 } });
    costlyLedger.configure(fixturePolicy());
    const personallyCapped = new QuestGateway(costlyLedger, async () => { calls++; return { output: 'never', usage: { input_tokens: 1, output_tokens: 1 } }; }, { clock: () => now });
    await assert.rejects(personallyCapped.call('person-cap', 'spend-cap', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }), /person daily budget exceeded/);
    personStore.close();
  } finally { store.close(); }
});

test('policy versions preserve an older receipt and releasing a hold is sealed and audited', () => {
  const { store, ledger, token } = fixture();
  try {
    const older = ledger.reserve(token, 'older', request()).row;
    ledger.dispatch(token, older.id);
    ledger.settle(older.id, { output: 'old result', usage: { input_tokens: older.input_bound, output_tokens: 1 } });
    const old = ledger.policy(); ledger.setPolicy(fixturePolicy({ day_micros: 99999 }));
    assert.equal(ledger.policy().day_micros, 99999); assert.equal(ledger.policyVersions().length, 2);
    assert.equal(ledger.receipts().find(row => row.id === older.id).state, 'settled');
    const row = ledger.reserve(token, 'hold', request()).row; ledger.dispatch(token, row.id);
    ledger.releaseHold(row.id, { actor: 'admin', reason: 'provider timeout' });
    const audit = ledger.holdAudits(); assert.equal(audit.length, 1); assert.equal(audit[0].actor, 'admin'); assert.ok(audit[0].seal);
    assert.equal(ledger.holds().length, 0);
    assert.equal(ledger.receipts().find(receipt => receipt.id === row.id).charged_micros, row.worst_micros);
    assert.equal(old.day_micros, 100000);
  } finally { store.close(); }
});

test('ordinary gateway reservations count already-settled Quest spend', async () => {
  const { store, ledger, token } = fixture(':memory:', { global_micros: 40, day_micros: 40 });
  try {
    const quest = new QuestGateway(ledger, async () => ({ output: 'ok', usage: { input_tokens: 9, output_tokens: 1 } }));
    await quest.call('member', 'quest-before-gateway', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 });
    assert.throws(() => ledger.reserve(token, 'gateway-after-quest', request()), /global cap exceeded/);
  } finally { store.close(); }
});

test('ordinary gateway reservations count already-settled Effort spend', async () => {
  const { store, ledger, token } = fixture(':memory:', { global_micros: 40, day_micros: 40 });
  try {
    const { EffortGateway } = await import('../gateway/effort.js');
    const effort = new EffortGateway(ledger, async () => ({ output: 'ok', usage: { input_tokens: 9, output_tokens: 1 } }));
    const done = await effort.call('member', 'effort-before-gateway', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }, 'item', 'job');
    assert.equal(done.status, 200);
    assert.throws(() => ledger.reserve(token, 'gateway-after-effort', request()), /global cap exceeded/);
  } finally { store.close(); }
});

test('gateway CLI versions policy, lists holds, and releases four timed-out holds so a fifth is admitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-slice17-')); const file = join(dir, 'sss.db');
  try {
    const { store, ledger, token } = fixture(file, { concurrency: 4 });
    const holdIds = [];
    for (let n = 0; n < 4; n++) {
      const row = ledger.reserve(token, `timeout:${n}`, request()).row;
      assert.equal(ledger.dispatch(token, row.id), true); holdIds.push(row.id);
    }
    assert.throws(() => ledger.reserve(token, 'fifth-before-release', request()), /concurrency/);
    store.close();

    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(fixturePolicy({ concurrency: 4, day_micros: 99999 })));
    const policyOutput = [];
    await main(['gateway', 'policy', 'set', '--file', policyFile], { SSS_DB: file }, line => policyOutput.push(line));
    assert.deepEqual(policyOutput, ['gateway policy version 2 set']);

    const listed = [];
    await main(['gateway', 'holds', 'list'], { SSS_DB: file }, line => listed.push(JSON.parse(line)));
    assert.deepEqual(listed.map(row => row.id).sort(), holdIds.slice().sort());
    const released = [];
    await main(['gateway', 'holds', 'release', '--id', holdIds[0], '--actor', 'admin', '--reason', 'timed out'],
      { SSS_DB: file }, line => released.push(JSON.parse(line)));
    assert.deepEqual(released, [{ id: holdIds[0], state: 'released', charged_micros: 33 }]);

    const reopened = new Store(file); const verified = new Ledger(reopened);
    try {
      assert.equal(verified.holds().length, 3);
      assert.equal(verified.holdAudits()[0].reason, 'timed out');
      assert.doesNotThrow(() => verified.reserve(token, 'fifth-after-release', request()));
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
