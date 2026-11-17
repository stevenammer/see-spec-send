import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { anthropicToChat, chatToAnthropic, streamTranslator, AnthropicRefusal } from '../gateway/anthropic.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider, fixtureChatProvider } from '../gateway/fixture.js';
import { fixture } from './helpers/gateway-fixture.mjs';

const MODEL = 'fixture:text-v1';
const body = (changes = {}) => ({ model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }], ...changes });
const refusal = (input, pattern) => assert.throws(() => anthropicToChat(input), error => error instanceof AnthropicRefusal && pattern.test(error.message));

test('requests translate to the OpenAI-shaped chat the gateway meters: system, text, tools and tool choice', () => {
  const chat = anthropicToChat(body({
    system: [{ type: 'text', text: 'Be brief.' }, { type: 'text', text: 'Use tools.' }],
    tools: [{ name: 'write_file', description: 'write', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    tool_choice: { type: 'any' }, stream: true, temperature: 0.2, top_p: 0.9, top_k: 5, stop_sequences: ['x'], metadata: { user_id: 'u' }, thinking: { type: 'enabled', budget_tokens: 1024 },
  }));
  assert.deepEqual(chat.messages, [{ role: 'system', content: 'Be brief.\nUse tools.' }, { role: 'user', content: 'hello' }]);
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]);
  assert.equal(chat.tool_choice, 'required'); assert.equal(chat.stream, true); assert.equal(chat.max_tokens, 64); assert.equal(chat.model, MODEL);
  assert.deepEqual(Object.keys(chat).sort(), ['max_tokens', 'messages', 'model', 'stream', 'tool_choice', 'tools'], 'sampling and bookkeeping fields are dropped, nothing else leaks through');
  for (const [given, expected] of [[{ type: 'auto' }, 'auto'], [{ type: 'none' }, 'none'], [{ type: 'tool', name: 'write_file' }, { type: 'function', function: { name: 'write_file' } }]]) {
    assert.deepEqual(anthropicToChat(body({ tool_choice: given })).tool_choice, expected);
  }
});

test('system-role entries in the message list (what Claude Code sends for a custom model label) merge into one leading system prompt', () => {
  const chat = anthropicToChat(body({ system: 'Top.', messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: 'Reminder.' }] }] }));
  assert.deepEqual(chat.messages, [{ role: 'system', content: 'Top.\n\nReminder.' }, { role: 'user', content: 'hi' }]);
  assert.deepEqual(anthropicToChat(body({ messages: [{ role: 'system', content: 'Only.' }, { role: 'user', content: 'hi' }] })).messages.map(m => m.role), ['system', 'user']);
});

test('tool use round-trips: an assistant tool_use and the user tool_result that answers it keep their order and ids', () => {
  const chat = anthropicToChat(body({ messages: [
    { role: 'user', content: 'make a page' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'index.html' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'done' }] }, { type: 'text', text: 'now style it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'write_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }] },
  ] }));
  assert.deepEqual(chat.messages, [
    { role: 'user', content: 'make a page' },
    { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'done' },
    { role: 'user', content: 'now style it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'Error: boom' },
  ]);
});

test('what the gateway cannot meter or contain is refused plainly, not silently dropped', () => {
  refusal(body({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] }), /"image" is not supported/);
  refusal(body({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), /not supported.*server-side/);
  refusal(body({ tools: [{ type: 'bash_20250124', name: 'bash', input_schema: { type: 'object' } }] }), /not supported.*server-side/);
  assert.equal(anthropicToChat(body({ tools: [{ type: 'custom', name: 'ok', input_schema: { type: 'object' } }] })).tools[0].function.name, 'ok', 'an explicit custom tool is fine');
  refusal(body({ unexpected: true }), /field "unexpected" is not supported/);
  refusal({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }, /max_tokens is required/);
  refusal(body({ messages: [] }), /non-empty/);
  refusal(body({ messages: [{ role: 'tool', content: 'x' }] }), /role of user, assistant or system/);
  refusal(body({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }), /tool_use_id/);
  refusal(body({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: 'not an object' }] }] }), /object input/);
  refusal(body({ tool_choice: { type: 'weird' } }), /unsupported tool_choice/);
  refusal(null, /JSON object/);
});

test('responses translate back: text, tool calls with parsed arguments, stop reasons and usage', () => {
  const text = chatToAnthropic({ id: 'chatcmpl-abc', choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, MODEL);
  assert.equal(text.type, 'message'); assert.equal(text.role, 'assistant'); assert.equal(text.model, MODEL); assert.equal(text.stop_reason, 'end_turn'); assert.equal(text.stop_sequence, null);
  assert.deepEqual(text.content, [{ type: 'text', text: 'Hi there' }]); assert.deepEqual(text.usage, { input_tokens: 7, output_tokens: 3 }); assert.match(text.id, /^msg_/);
  const tools = chatToAnthropic({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.html"}' } }, { id: 'call_2', type: 'function', function: { name: 'bad', arguments: 'not json' } }] }, finish_reason: 'tool_calls' }], usage: { input_tokens: 1, output_tokens: 2 } }, MODEL);
  assert.equal(tools.stop_reason, 'tool_use');
  assert.deepEqual(tools.content, [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.html' } }, { type: 'tool_use', id: 'call_2', name: 'bad', input: {} }]);
  assert.equal(chatToAnthropic({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, MODEL).stop_reason, 'max_tokens');
  assert.deepEqual(chatToAnthropic({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, MODEL).content, [{ type: 'text', text: '' }], 'an empty reply is still one block');
});

const run = (chunks) => { const events = []; const stream = streamTranslator(MODEL, (name, data) => events.push([name, data])); for (const chunk of chunks) { if (chunk === '[DONE]') stream.done(); else stream.chunk(chunk); } stream.done(); return events; };
const names = events => events.map(([name]) => name);

test('a text stream becomes the exact Anthropic event sequence, with usage and stop reason at the end', () => {
  const events = run([
    { id: 'c1', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
    { id: 'c1', choices: [{ delta: { content: 'lo' } }] },
    { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } }, '[DONE]']);
  assert.deepEqual(names(events), ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(events.filter(([name]) => name === 'content_block_delta').map(([, data]) => data.delta), [{ type: 'text_delta', text: 'Hel' }, { type: 'text_delta', text: 'lo' }]);
  assert.deepEqual(events.at(-2)[1], { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 11, output_tokens: 2 } });
});

test('a tool call streams as a tool_use block with partial JSON, after any text, each block closed before the next opens', () => {
  const events = run([
    { choices: [{ delta: { content: 'Writing. ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.html"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_10', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 9 } }]);
  assert.deepEqual(names(events), ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const starts = events.filter(([name]) => name === 'content_block_start').map(([, data]) => [data.index, data.content_block.type, data.content_block.name]);
  assert.deepEqual(starts, [[0, 'text', undefined], [1, 'tool_use', 'write_file'], [2, 'tool_use', 'read_file']]);
  const json = events.filter(([, data]) => data.delta?.type === 'input_json_delta' && data.index === 1).map(([, data]) => data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { path: 'a.html' });
  assert.equal(events.at(-2)[1].delta.stop_reason, 'tool_use');
});

test('a gateway refusal mid-stream ends with an error event and nothing after it; an empty reply still yields a block', () => {
  const events = run([{ choices: [{ delta: { content: 'part' } }] }, { error: { message: 'gateway stream aborted', type: 'gateway_refusal' } }, '[DONE]']);
  assert.deepEqual(names(events).slice(-2), ['content_block_stop', 'error']);
  assert.equal(events.at(-1)[1].error.type, 'api_error');
  assert.deepEqual(names(run(['[DONE]'])), ['message_start', 'ping', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop']);
});

async function serve(t, options = {}) {
  const made = fixture(':memory:', options.policy || {}, options.cap ?? 0.1); t.after(() => made.store.close());
  const server = createGatewayServer(new Gateway(made.ledger, fixtureProvider), new ChatGateway(made.ledger, options.provider || fixtureChatProvider));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) { if (error.code === 'EPERM') return null; throw error; }
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...made, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (setup, path, input, headers = {}) => fetch(`${setup.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': setup.token, ...headers }, body: JSON.stringify(input) });

test('POST /v1/messages answers in Anthropic format and is metered on the same ledger as chat completions', async t => {
  const setup = await serve(t); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const before = setup.ledger.receipts().length;
  const plain = await post(setup, '/v1/messages?beta=true', body());
  assert.equal(plain.status, 200);
  const message = await plain.json();
  assert.equal(message.type, 'message'); assert.deepEqual(message.content, [{ type: 'text', text: 'Fixture chat result' }]); assert.equal(message.stop_reason, 'end_turn');
  assert.equal(setup.ledger.receipts().length, before + 1, 'the call produced one ledger receipt');
  assert.equal(setup.ledger.receipts().at(-1).state, 'settled');
  const bearer = await post(setup, '/v1/messages', body(), { 'x-api-key': '', authorization: `Bearer ${setup.token}` });
  assert.equal(bearer.status, 200, 'a Bearer token works as well as x-api-key');
  const tool = await post(setup, '/v1/messages', body({ tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object' } }] }));
  const toolMessage = await tool.json();
  assert.equal(toolMessage.stop_reason, 'tool_use'); assert.deepEqual(toolMessage.content, [{ type: 'tool_use', id: 'call_fixture', name: 'read_file', input: { fixture: true } }]);
});

test('POST /v1/messages streams Anthropic events and settles the stream\'s usage', async t => {
  const setup = await serve(t); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const response = await post(setup, '/v1/messages', body({ stream: true }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  const events = [...text.matchAll(/^event: (\w+)\ndata: (.+)$/gm)].map(match => [match[1], JSON.parse(match[2])]);
  assert.deepEqual(names(events), ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(setup.ledger.receipts().at(-1).state, 'settled');
  assert.ok(events.at(-2)[1].usage.output_tokens >= 1);
});

test('the endpoint refuses without a capability, with the wrong model, and past the budget, in Anthropic error shape', async t => {
  const setup = await serve(t); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const none = await fetch(`${setup.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(none.status, 401); assert.deepEqual(await none.json(), { type: 'error', error: { type: 'authentication_error', message: 'capability required' } });
  const forged = await post(setup, '/v1/messages', body(), { 'x-api-key': 'A'.repeat(43) });
  assert.equal(forged.status, 403); assert.equal((await forged.json()).error.type, 'permission_error');
  const wrong = await post(setup, '/v1/messages', body({ model: 'some-other-model' }));
  assert.equal(wrong.status, 400); assert.equal((await wrong.json()).error.type, 'invalid_request_error');
  const bad = await post(setup, '/v1/messages', body({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }));
  assert.equal(bad.status, 400); assert.match((await bad.json()).error.message, /not supported/);
  const tiny = await serve(t, { cap: 0.000001 });
  const over = await post(tiny, '/v1/messages', body());
  assert.equal(over.status, 402); assert.equal((await over.json()).error.type, 'billing_error');
  assert.equal(tiny.ledger.receipts().length, 0, 'a refused call reserves nothing');
});

test('count_tokens is an unmetered estimate and creates no receipt; other methods and paths are refused', async t => {
  const setup = await serve(t); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const response = await post(setup, '/v1/messages/count_tokens', { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(400) }] });
  assert.equal(response.status, 200);
  const counted = (await response.json()).input_tokens;
  assert.ok(counted >= 100 && counted <= 200, `estimate ${counted}`);
  assert.equal(setup.ledger.receipts().length, 0);
  const get = await fetch(`${setup.base}/v1/messages`, { headers: { 'x-api-key': setup.token } });
  assert.equal(get.status, 405);
  const other = await post(setup, '/v1/models', {});
  assert.equal(other.status, 404);
});
