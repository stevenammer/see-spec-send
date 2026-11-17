import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { anthropicToChat, chatToAnthropicRequest, anthropicToChatResult, anthropicEventsToChunks } from '../gateway/anthropic.js';
import { anthropicMessages } from '../provider/adapters.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider } from '../gateway/fixture.js';
import { fixture } from './helpers/gateway-fixture.mjs';

const MODEL = 'fixture:text-v1';
const tools = [{ type: 'function', function: { name: 'write_file', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const conversation = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'make a page' },
  { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } }] },
  { role: 'tool', tool_call_id: 'toolu_1', content: 'done' },
  { role: 'user', content: 'now style it' },
];

test('a chat request translates to Anthropic\'s Messages request: system, tool_use, tool_result first, tools and tool choice', () => {
  const body = chatToAnthropicRequest({ model: MODEL, messages: conversation, tools, tool_choice: 'required', max_tokens: 256, stream: true });
  assert.equal(body.system, 'Be brief.'); assert.equal(body.max_tokens, 256); assert.equal(body.stream, true); assert.equal(body.model, MODEL);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'make a page' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'index.html' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }, { type: 'text', text: 'now style it' }] },
  ]);
  assert.deepEqual(body.tools, [{ name: 'write_file', description: 'write a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
  assert.deepEqual(body.tool_choice, { type: 'any' });
  assert.deepEqual(chatToAnthropicRequest({ model: MODEL, messages: conversation, tools, tool_choice: 'auto' }).tool_choice, { type: 'auto' });
  assert.deepEqual(chatToAnthropicRequest({ model: MODEL, messages: conversation, tools, tool_choice: { type: 'function', function: { name: 'write_file' } } }).tool_choice, { type: 'tool', name: 'write_file' });
  assert.equal(chatToAnthropicRequest({ model: MODEL, messages: conversation, tools, tool_choice: 'none' }).tools, undefined, 'none means the model is not offered the tools');
  assert.equal(chatToAnthropicRequest({ model: MODEL, messages: conversation }).stream, undefined);
  assert.deepEqual(chatToAnthropicRequest({ model: MODEL, messages: [{ role: 'user', content: 'x' }], functions: [{ name: 'f', parameters: { type: 'object' } }] }).tools, [{ name: 'f', input_schema: { type: 'object' } }]);
});

test('translating to Anthropic\'s format and back returns the same conversation', () => {
  const body = chatToAnthropicRequest({ model: MODEL, messages: conversation, tools, tool_choice: 'auto', max_tokens: 256 });
  const again = anthropicToChat(body);
  assert.deepEqual(again.messages, conversation);
  assert.deepEqual(again.tools, tools); assert.equal(again.tool_choice, 'auto'); assert.equal(again.max_tokens, 256); assert.equal(again.model, MODEL);
});

test('an Anthropic message becomes an OpenAI-shaped completion with arguments as a JSON string, finish reason and usage', () => {
  const result = anthropicToChatResult({ id: 'msg_1', model: MODEL, role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 30, output_tokens: 12 },
    content: [{ type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'toolu_9', name: 'write_file', input: { path: 'a.html' } }] });
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0].message, { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.html"}' } }] });
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });
  assert.equal(anthropicToChatResult({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'x' }] }).choices[0].finish_reason, 'length');
  assert.equal(anthropicToChatResult({ stop_reason: 'end_turn', content: [] }).choices[0].message.content, '');
});

const events = [
  { type: 'message_start', message: { id: 'msg_s', model: MODEL, usage: { input_tokens: 25, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Work' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_m1', name: 'write_file', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.html"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
  { type: 'message_stop' },
];
async function collect(source) { const out = []; for await (const chunk of source) out.push(chunk); return out; }

test('Anthropic stream events become OpenAI chunks that end with the usage the gateway settles on', async () => {
  const chunks = await collect(anthropicEventsToChunks(events));
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
  assert.equal(chunks.filter(chunk => chunk.choices[0].delta.content).map(chunk => chunk.choices[0].delta.content).join(''), 'Working');
  const toolChunks = chunks.filter(chunk => chunk.choices[0].delta.tool_calls).map(chunk => chunk.choices[0].delta.tool_calls[0]);
  assert.deepEqual(toolChunks[0], { index: 0, id: 'toolu_m1', type: 'function', function: { name: 'write_file', arguments: '' } });
  assert.deepEqual(JSON.parse(toolChunks.slice(1).map(call => call.function.arguments).join('')), { path: 'a.html' });
  assert.ok(toolChunks.slice(1).every(call => call.index === 0));
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, 'tool_calls'); assert.deepEqual(last.usage, { prompt_tokens: 25, completion_tokens: 17, total_tokens: 42 });
  await assert.rejects(collect(anthropicEventsToChunks([{ type: 'message_start', message: {} }, { type: 'error', error: { type: 'overloaded_error' } }])), /provider stream error: overloaded_error/);
});

// A stand-in for api.anthropic.com. It checks the headers and the body it was sent and answers JSON or an SSE stream.
async function mockAnthropic(t) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ headers: req.headers, body, url: req.url });
    if (req.headers['x-api-key'] !== 'secret-key' || req.headers['anthropic-version'] !== '2023-06-01') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_j', type: 'message', role: 'assistant', model: MODEL, stop_reason: 'tool_use', usage: { input_tokens: 25, output_tokens: 17 },
      content: [{ type: 'text', text: 'Working' }, { type: 'tool_use', id: 'toolu_m1', name: 'write_file', input: { path: 'a.html' } }] }));
  });
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) { if (error.code === 'EPERM') return null; throw error; }
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, config: { url: `http://127.0.0.1:${server.address().port}/v1/messages`, hosts: ['127.0.0.1'], allowPrivate: true, apiKey: 'secret-key', requestBytes: 200_000, responseBytes: 200_000 } };
}

test('the anthropic provider\'s chat sends Anthropic\'s headers and format, and returns OpenAI-shaped results, plain and streaming', async t => {
  const mock = await mockAnthropic(t); if (!mock) return t.skip('sandbox blocks loopback listeners');
  const provider = anthropicMessages(mock.config);
  const plain = await provider.chat({ model: MODEL, messages: conversation, tools, max_tokens: 64, stream: false });
  assert.equal(plain.choices[0].message.tool_calls[0].function.name, 'write_file'); assert.deepEqual(plain.usage, { prompt_tokens: 25, completion_tokens: 17, total_tokens: 42 });
  assert.equal(mock.seen[0].headers['x-api-key'], 'secret-key'); assert.equal(mock.seen[0].body.system, 'Be brief.'); assert.equal(mock.seen[0].body.tools[0].name, 'write_file');
  const chunks = await collect(await provider.chat({ model: MODEL, messages: conversation, tools, max_tokens: 64, stream: true }));
  assert.equal(mock.seen[1].body.stream, true);
  assert.equal(chunks.at(-1).usage.completion_tokens, 17);
  assert.equal(chunks.filter(chunk => chunk.choices[0].delta.content).map(chunk => chunk.choices[0].delta.content).join(''), 'Working');
  const wrong = anthropicMessages({ ...mock.config, apiKey: 'nope' });
  await assert.rejects(wrong.chat({ model: MODEL, messages: conversation, max_tokens: 8, stream: false }), /provider HTTP 401/);
});

test('the whole chain: a client speaking Anthropic\'s format, the metered gateway, the anthropic provider, and back', async t => {
  const mock = await mockAnthropic(t); if (!mock) return t.skip('sandbox blocks loopback listeners');
  const made = fixture(); t.after(() => made.store.close());
  const server = createGatewayServer(new Gateway(made.ledger, fixtureProvider), new ChatGateway(made.ledger, anthropicMessages(mock.config)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const post = input => fetch(`http://127.0.0.1:${server.address().port}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': made.token }, body: JSON.stringify(input) });
  const request = { model: MODEL, max_tokens: 64, system: 'Be brief.', messages: [{ role: 'user', content: 'make a page' }], tools: [{ name: 'write_file', description: 'write a file', input_schema: tools[0].function.parameters }] };
  const message = await (await post(request)).json();
  assert.equal(message.stop_reason, 'tool_use'); assert.deepEqual(message.content[1], { type: 'tool_use', id: 'toolu_m1', name: 'write_file', input: { path: 'a.html' } });
  assert.deepEqual(message.usage, { input_tokens: 25, output_tokens: 17 });
  assert.equal(mock.seen[0].body.system, 'Be brief.', 'the upstream got what the client sent');
  const streamed = await (await post({ ...request, stream: true })).text();
  assert.match(streamed, /event: message_start/); assert.match(streamed, /"input_json_delta"/); assert.match(streamed, /event: message_stop/);
  const receipts = made.ledger.receipts();
  assert.equal(receipts.length, 2); assert.ok(receipts.every(receipt => receipt.state === 'settled'), 'both calls were metered and settled');
  assert.deepEqual(JSON.parse(receipts[0].usage), { input_tokens: 25, output_tokens: 17 });
});

test('tool results always lead the user turn, even when a note precedes them in the chat history', () => {
  const body = chatToAnthropicRequest({ model: MODEL, messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'user', content: 'a note' },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
  ] });
  assert.deepEqual(body.messages[1], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }, { type: 'text', text: 'a note' }] });
});

test('with two tool calls in one reply, each one\'s arguments stream onto its own call', async () => {
  const two = [
    { type: 'message_start', message: { id: 'm', model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'first', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_b', name: 'second', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"b":2}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }];
  const calls = (await collect(anthropicEventsToChunks(two))).flatMap(chunk => chunk.choices[0].delta.tool_calls || []);
  const argumentsFor = index => calls.filter(call => call.index === index).map(call => call.function.arguments).join('');
  assert.equal(argumentsFor(0), '{"a":1}'); assert.equal(argumentsFor(1), '{"b":2}');
  assert.deepEqual(calls.filter(call => call.id).map(call => [call.index, call.function.name]), [[0, 'first'], [1, 'second']]);
});
