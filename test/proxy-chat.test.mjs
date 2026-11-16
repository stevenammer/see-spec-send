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

// Found by running a real agent through the proxy: agents send no Idempotency-Key,
// and a refusal after the stream began once crashed the whole gateway process.
test('wire: no Idempotency-Key is a fresh metered call; a refused stream is a normal HTTP error and the server survives', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const server = createGatewayServer(new Gateway(ledger, fixtureProvider), new ChatGateway(ledger, fixtureChatProvider));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('sandbox blocks loopback listeners'); return; }
    throw error;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const a = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat()) });
  const b = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat()) });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(ledger.receipts().length, 2, 'two keyless requests are two metered calls');
  // An over-limit streaming request is refused before any event stream starts.
  const refused = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat({ stream: true, provider_options: { anything: 1 } })) });
  assert.ok([400, 402].includes(refused.status), `got ${refused.status}`);
  assert.notEqual(refused.headers.get('content-type'), 'text/event-stream');
  const after = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat()) });
  assert.equal(after.status, 200, 'the gateway is still alive');
});

test('wire: agent sampling parameters are accepted and dropped, a missing limit is clamped to policy, unknown keys are refused', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const server = createGatewayServer(new Gateway(ledger, fixtureProvider), new ChatGateway(ledger, fixtureChatProvider));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('sandbox blocks loopback listeners'); return; }
    throw error;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const { max_tokens: _omit, ...bare } = chat();
  const agent = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...bare, temperature: 0.2, top_p: 1, stream_options: { include_usage: true }, parallel_tool_calls: true }) });
  assert.equal(agent.status, 200);
  const huge = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat({ max_tokens: 10_000_000 })) });
  assert.equal(huge.status, 200, 'an oversized limit is clamped, never exceeded');
  assert.ok(ledger.receipts().every(row => row.output_bound <= ledger.policy().output_tokens));
  for (const bad of [{ response_format: { type: 'json_object' } }, { stream_options: { other: true } }, { n: 2 }, { __proto__: { x: 1 }, constructor: 1 }])
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat(bad)) })).status, 400);
});

test('provider-style usage (prompt_tokens, completion_tokens) settles the hold for normal and streamed calls', async () => {
  const { normalizeUsage } = await import('../gateway/http.js');
  assert.deepEqual(normalizeUsage({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }), { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(normalizeUsage({ input_tokens: 1, output_tokens: 2 }), { input_tokens: 1, output_tokens: 2 });
  assert.equal(normalizeUsage(undefined), undefined);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1.5, completion_tokens: 2 }), { prompt_tokens: 1.5, completion_tokens: 2 }, 'malformed usage is left to fail closed');
});

test('a gateway call whose provider reports OpenAI-style usage settles instead of staying held', async t => {
  const { store, ledger, token } = fixture(); t.after(() => store.close());
  const provider = { async chat() { return { id: 'c', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }; } };
  const chatGateway = new ChatGateway(ledger, provider);
  const result = await chatGateway.call(token, 'oa:1', chat());
  assert.equal(result.status, 200);
  assert.equal(ledger.receipts().at(-1).state, 'settled');
});
