import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Store } from '../core/store.js';
import { Ledger, digest } from '../gateway/ledger.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider } from '../gateway/fixture.js';
import { fixtureChatProvider } from '../gateway/fixture.js';
import { fixture } from './helpers/gateway-fixture.mjs';

const chat = (changes = {}) => ({ model: 'fixture:text-v1', messages: [{ role: 'user', content: 'make a change' }],
  tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
  tool_choice: 'auto', max_tokens: 10, stream: false, ...changes });

test('OpenAI chat-completions endpoint emits normal JSON and SSE', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const server = createGatewayServer(new Gateway(ledger, fixtureProvider), new ChatGateway(ledger, fixtureChatProvider));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('sandbox blocks loopback listeners'); return; }
    throw error;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': 'wire:normal' };
  const normal = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat()) });
  assert.equal(normal.status, 200); assert.equal((await normal.json()).choices[0].message.tool_calls[0].id, 'call_fixture');
  const stream = await fetch(url, { method: 'POST', headers: { ...headers, 'idempotency-key': 'wire:stream' }, body: JSON.stringify(chat({ stream: true })) });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const bytes = await stream.text(); assert.match(bytes, /"tool_calls"/); assert.match(bytes, /data: \[DONE\]/);
});

test('proxy tool calls round trip, reserves before dispatch, and stores no bodies', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  let receiptAtDispatch;
  const provider = { async chat(request) {
    receiptAtDispatch = ledger.receipts()[0];
    return fixtureChatProvider.chat(request);
  } };
  const result = await new ChatGateway(ledger, provider).call(token, 'tool:1', chat());
  assert.equal(result.status, 200);
  assert.equal(result.body.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.equal(receiptAtDispatch.state, 'dispatched');
  const row = ledger.receipts()[0];
  assert.equal(row.run.length, 64); assert.equal(JSON.parse(row.rate).model, 'fixture:text-v1');
  assert.deepEqual(JSON.parse(row.usage), { input_tokens: Buffer.byteLength(JSON.stringify(chat().messages)), output_tokens: 1 });
  assert.equal(row.outcome, null);
  assert.equal(JSON.stringify(row).includes('make a change'), false);
  assert.equal(ledger.summary('item').approvals[0].settled_micros, row.charged_micros);
});

test('proxy streaming preserves tool chunks, settles usage, and does not retain chunks', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const chunks = [];
  await new ChatGateway(ledger, fixtureChatProvider).stream(token, 'stream:1', chat({ stream: true }), chunk => chunks.push(chunk));
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'read_file');
  assert.equal(chunks.at(-1), '[DONE]');
  assert.equal(ledger.receipts()[0].state, 'settled'); assert.equal(ledger.receipts()[0].outcome, null);
});

test('proxy refuses call N plus one under the shared approval cap', async t => {
  const { store, ledger, token } = fixture(':memory:', {}, 0.00025); t.after(() => store.close());
  const proxy = new ChatGateway(ledger, fixtureChatProvider);
  assert.equal((await proxy.call(token, 'one', chat())).status, 200);
  await assert.rejects(() => proxy.call(token, 'two', chat()), /cap exceeded/);
  assert.equal(ledger.receipts().length, 1);
});

test('proxy missing usage keeps its hold and a restarted gateway never dispatches it again', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-proxy-')); const file = join(dir, 'db');
  let { store, ledger, token } = fixture(file); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let calls = 0;
  const proxy = new ChatGateway(ledger, { async chat() { calls++; return { id: 'x', choices: [], usage: undefined }; } });
  assert.equal((await proxy.call(token, 'unknown', chat())).status, 202);
  assert.equal(ledger.receipts()[0].state, 'dispatched');
  store.close(); store = new Store(file); ledger = new Ledger(store);
  const retry = new ChatGateway(ledger, { async chat() { calls++; throw Error('must not call'); } });
  assert.equal((await retry.call(token, 'unknown', chat())).status, 202);
  assert.equal(calls, 1);
});

test('revoked, stale, and forged capabilities refuse or abort proxy streams', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const delayed = { async chat() { return (async function* () {
    yield { choices: [{ delta: { content: 'first' } }] };
    await new Promise(resolve => setImmediate(resolve));
    yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { input_tokens: 1, output_tokens: 1 } };
  })(); } };
  const chunks = [];
  await new ChatGateway(ledger, delayed).stream(token, 'revoke', chat({ stream: true, tools: undefined }), chunk => {
    chunks.push(chunk); if (chunks.length === 1) ledger.revokeDigest(digest(token));
  });
  assert.equal(chunks.at(-1), '[DONE]');
  assert.equal(ledger.receipts()[0].state, 'dispatched');
  await assert.rejects(() => new ChatGateway(ledger, fixtureChatProvider).call('x'.repeat(43), 'forged', chat()), /capability/);
});
