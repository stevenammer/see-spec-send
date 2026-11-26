import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { responsesToChat, chatToResponse, responsesStream, ResponsesRefusal } from '../gateway/responses.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider, fixtureChatProvider } from '../gateway/fixture.js';
import { fixture } from './helpers/gateway-fixture.mjs';

const MODEL = 'fixture:text-v1';
const body = (changes = {}) => ({ model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], ...changes });
const refusal = (input, pattern) => assert.throws(() => responsesToChat(input), error => error instanceof ResponsesRefusal && pattern.test(error.message));

test('a Responses request translates to the OpenAI-shaped chat the gateway meters: instructions, developer messages, tools', () => {
  const chat = responsesToChat(body({
    instructions: 'Be brief.', stream: true, max_output_tokens: 300,
    input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Rules.' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make a page' }] }],
    tools: [{ type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } }, strict: false },
      { type: 'web_search' }, { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn' }] }, { type: 'custom', name: 'apply_patch' }],
    tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', client_metadata: { a: 'b' },
  }));
  assert.deepEqual(chat.messages, [{ role: 'system', content: 'Be brief.\n\nRules.' }, { role: 'user', content: 'make a page' }]);
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'exec_command', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }], 'only function tools are offered; web search, namespaces and custom tools are not');
  assert.equal(chat.tool_choice, 'auto'); assert.equal(chat.stream, true); assert.equal(chat.max_tokens, 300);
  assert.deepEqual(Object.keys(chat).sort(), ['max_tokens', 'messages', 'model', 'stream', 'tool_choice', 'tools'], 'nothing else leaks through');
  assert.deepEqual(responsesToChat(body({ input: 'plain text' })).messages, [{ role: 'user', content: 'plain text' }]);
  assert.equal(responsesToChat(body({ tools: [{ type: 'web_search' }] })).tools, undefined, 'a list with no function tools offers none');
  assert.deepEqual(responsesToChat(body({ tools: [{ type: 'function', name: 'f' }], tool_choice: { type: 'function', name: 'f' } })).tool_choice, { type: 'function', function: { name: 'f' } });
});

test('tool calls and their outputs keep their order and ids; reasoning items are dropped', () => {
  const chat = responsesToChat(body({ input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make a page' }] },
    { type: 'reasoning', summary: [], encrypted_content: 'xxx' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Writing.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { type: 'function_call', call_id: 'call_2', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'index.html' },
    { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: '/work' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now style it' }] },
  ] }));
  assert.deepEqual(chat.messages, [
    { role: 'user', content: 'make a page' },
    { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }, { id: 'call_2', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'index.html' },
    { role: 'tool', tool_call_id: 'call_2', content: '/work' },
    { role: 'user', content: 'now style it' },
  ]);
  const bare = responsesToChat(body({ input: [{ type: 'message', role: 'user', content: 'x' }, { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] }));
  assert.deepEqual(bare.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] });
});

test('state, images and anything the gateway cannot meter or contain is refused plainly', () => {
  refusal(body({ previous_response_id: 'resp_1' }), /previous_response_id.*no conversation state/);
  refusal(body({ conversation: 'c' }), /not supported/); refusal(body({ background: true }), /not supported/); refusal(body({ prompt: { id: 'p' } }), /not supported/);
  refusal(body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] }), /"input_image" is not supported/);
  refusal(body({ input: [{ type: 'local_shell_call', call_id: 'x' }] }), /"local_shell_call" is not supported/);
  refusal(body({ input: [{ type: 'custom_tool_call', call_id: 'x', name: 'apply_patch', input: '' }] }), /"custom_tool_call" is not supported/);
  refusal(body({ unexpected: 1 }), /field "unexpected" is not supported/);
  refusal(body({ input: [] }), /non-empty/); refusal({ input: 'x' }, /model is required/); refusal(null, /JSON object/);
  refusal(body({ max_output_tokens: 0 }), /positive integer/);
  refusal(body({ input: [{ type: 'message', role: 'tool', content: 'x' }] }), /role of user, assistant, system or developer/);
  refusal(body({ input: [{ type: 'function_call', name: 'f' }] }), /call_id/);
});

test('responses translate back: text, function calls, usage, and an incomplete status when the model ran out of tokens', () => {
  const text = chatToResponse({ id: 'chatcmpl-abc', choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, MODEL);
  assert.equal(text.object, 'response'); assert.equal(text.status, 'completed'); assert.equal(text.model, MODEL); assert.match(text.id, /^resp_/);
  assert.deepEqual(text.output[0].content, [{ type: 'output_text', text: 'Hi there', annotations: [] }]); assert.equal(text.output[0].role, 'assistant');
  assert.deepEqual(text.usage, { input_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 10 });
  const tools = chatToResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] }, finish_reason: 'tool_calls' }], usage: { input_tokens: 1, output_tokens: 2 } }, MODEL);
  assert.equal(tools.output.length, 1); assert.deepEqual([tools.output[0].type, tools.output[0].call_id, tools.output[0].name, tools.output[0].arguments], ['function_call', 'call_1', 'exec_command', '{"cmd":"ls"}']);
  const cut = chatToResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, MODEL);
  assert.equal(cut.status, 'incomplete'); assert.deepEqual(cut.incomplete_details, { reason: 'max_output_tokens' });
  assert.deepEqual(chatToResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, MODEL).output[0].content[0].text, '', 'an empty reply is still one item');
});

const run = chunks => { const events = []; const stream = responsesStream(MODEL, (name, data) => events.push([name, data])); for (const chunk of chunks) { if (chunk === '[DONE]') stream.done(); else stream.chunk(chunk); } stream.done(); return events; };
const names = events => events.map(([name]) => name);

test('a text stream becomes the Responses event sequence, in order, with numbered events and the final usage', () => {
  const events = run([
    { id: 'c1', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }, { id: 'c1', choices: [{ delta: { content: 'lo' } }] },
    { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } }, '[DONE]']);
  assert.deepEqual(names(events), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
  assert.deepEqual(events.map(([, data]) => data.sequence_number), [...events.keys()], 'events are numbered in order');
  assert.ok(events.every(([name, data]) => data.type === name));
  const completed = events.at(-1)[1].response;
  assert.equal(completed.status, 'completed'); assert.equal(completed.output[0].content[0].text, 'Hello'); assert.equal(completed.usage.input_tokens, 11); assert.equal(completed.usage.total_tokens, 13);
});

test('function calls stream as function_call items with argument deltas; text closes before the first call opens', () => {
  const events = run([
    { choices: [{ delta: { content: 'Writing. ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'exec_command', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_10', type: 'function', function: { name: 'write_stdin', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 9 } }]);
  const added = events.filter(([name]) => name === 'response.output_item.added').map(([, data]) => [data.output_index, data.item.type, data.item.name]);
  assert.deepEqual(added, [[0, 'message', undefined], [1, 'function_call', 'exec_command'], [2, 'function_call', 'write_stdin']]);
  const closed = events.filter(([name]) => name === 'response.output_item.done').map(([, data]) => data.output_index);
  assert.deepEqual(closed, [0, 1, 2], 'each item closes before the next opens, in order');
  const deltas = events.filter(([name]) => name === 'response.function_call_arguments.delta').map(([, data]) => [data.output_index, data.delta]);
  assert.deepEqual(deltas, [[1, '{"cmd":'], [1, '"ls"}'], [2, '{}']]);
  const done = events.filter(([name]) => name === 'response.function_call_arguments.done').map(([, data]) => [data.output_index, data.arguments]);
  assert.deepEqual(done, [[1, '{"cmd":"ls"}'], [2, '{}']]);
  const completed = events.at(-1)[1].response;
  assert.deepEqual(completed.output.map(item => item.type), ['message', 'function_call', 'function_call']);
  assert.equal(completed.output[1].call_id, 'call_9'); assert.equal(completed.output[1].arguments, '{"cmd":"ls"}');
});

test('a token limit ends the stream as incomplete, a gateway refusal as failed, and an empty reply still yields an item', () => {
  assert.equal(names(run([{ choices: [{ delta: { content: 'part' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }])).at(-1), 'response.incomplete');
  const failed = run([{ choices: [{ delta: { content: 'part' } }] }, { error: { message: 'gateway stream aborted', type: 'gateway_refusal' } }, '[DONE]']);
  assert.equal(names(failed).at(-1), 'response.failed'); assert.equal(failed.at(-1)[1].response.status, 'failed'); assert.equal(failed.at(-1)[1].response.error.code, 'server_error');
  assert.ok(!names(failed).includes('response.completed'));
  assert.deepEqual(names(run(['[DONE]'])), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
});

async function serve(t, options = {}) {
  const made = fixture(':memory:', options.policy || {}, options.cap ?? 0.1); t.after(() => made.store.close());
  const server = createGatewayServer(new Gateway(made.ledger, fixtureProvider), options.chat?.(made.ledger) || new ChatGateway(made.ledger, fixtureChatProvider));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) { if (error.code === 'EPERM') return null; throw error; }
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...made, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (setup, input, headers = {}) => fetch(`${setup.base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setup.token}`, ...headers }, body: JSON.stringify(input) });

// A chat gateway that opens the event stream, sends one chunk, then fails. ChatGateway.stream turns provider failures into
// an error event itself, so this is the path left: something after the stream began throws (an accounting or settle fault).
const failsMidStream = ledger => ({ ledger, async stream(token, idem, chat, send, begin) {
  begin(); send({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: chat.model, choices: [{ index: 0, delta: { content: 'part' }, finish_reason: null }] });
  throw new Error('accounting failed after the stream began');
} });
test('a failure after the stream began ends the response, so the agent is not left waiting on an open stream', async t => {
  const setup = await serve(t, { chat: failsMidStream }); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const response = await fetch(`${setup.base}/v1/responses`, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${setup.token}` }, body: JSON.stringify(body({ stream: true })) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();   // resolves only once the server ends the response
  assert.match(text, /^event: /m);
});

test('POST /v1/responses answers in Responses format and is metered on the same ledger as chat completions', async t => {
  const setup = await serve(t); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const before = setup.ledger.receipts().length;
  const plain = await post(setup, body());
  assert.equal(plain.status, 200);
  const response = await plain.json();
  assert.equal(response.object, 'response'); assert.equal(response.output[0].content[0].text, 'Fixture chat result');
  assert.equal(setup.ledger.receipts().length, before + 1); assert.equal(setup.ledger.receipts().at(-1).state, 'settled');
  const tool = await (await post(setup, body({ tools: [{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object' } }, { type: 'web_search' }] }))).json();
  assert.deepEqual([tool.output[0].type, tool.output[0].name, tool.output[0].call_id, JSON.parse(tool.output[0].arguments)], ['function_call', 'read_file', 'call_fixture', { fixture: true }]);
  const streamed = await post(setup, body({ stream: true }));
  assert.equal(streamed.headers.get('content-type'), 'text/event-stream');
  const events = [...(await streamed.text()).matchAll(/^event: ([\w.]+)\ndata: (.+)$/gm)].map(match => [match[1], JSON.parse(match[2])]);
  assert.equal(events[0][0], 'response.created'); assert.equal(events.at(-1)[0], 'response.completed');
  assert.equal(setup.ledger.receipts().at(-1).state, 'settled'); assert.ok(events.at(-1)[1].response.usage.output_tokens >= 1);
});

test('the Responses endpoint refuses without a capability, with the wrong model, stateful requests, and past the budget', async t => {
  const setup = await serve(t); if (!setup) return t.skip('sandbox blocks loopback listeners');
  const none = await fetch(`${setup.base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(none.status, 401); assert.equal((await none.json()).error.code, 'invalid_api_key');
  const forged = await post(setup, body(), { authorization: `Bearer ${'A'.repeat(43)}` });
  assert.equal(forged.status, 403);
  const wrong = await post(setup, body({ model: 'some-other-model' })); assert.equal(wrong.status, 400);
  const stateful = await post(setup, body({ previous_response_id: 'resp_1' })); assert.equal(stateful.status, 400); assert.match((await stateful.json()).error.message, /no conversation state/);
  const tiny = await serve(t, { cap: 0.000001 });
  const over = await post(tiny, body()); assert.equal(over.status, 402); assert.equal((await over.json()).error.type, 'insufficient_quota');
  assert.equal(tiny.ledger.receipts().length, 0, 'a refused call reserves nothing');
  const get = await fetch(`${setup.base}/v1/responses`, { headers: { authorization: `Bearer ${setup.token}` } });
  assert.equal(get.status, 405);
});
