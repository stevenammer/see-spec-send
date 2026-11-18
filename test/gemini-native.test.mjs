import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chunksOf, fromGemini, generationConfig, geminiNative, modelUrl, toGemini } from '../provider/gemini-native.js';

const tools = [{ type: 'function', function: { name: 'write_file', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

test('chat messages become Gemini contents: system text apart, tool calls and results as function parts, neighbours merged', () => {
  const signatures = new Map([['call_1', 'SIG']]);
  const body = toGemini({ model: 'google/gemini-3.8-flash', max_tokens: 99, tools, tool_choice: 'required', messages: [
    { role: 'system', content: 'Be brief.' }, { role: 'user', content: 'make a page' },
    { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' }, { role: 'user', content: 'now style it' } ] }, { signatures });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'make a page' }] },
    { role: 'model', parts: [{ text: 'Writing.' }, { functionCall: { name: 'write_file', args: { path: 'index.html' } }, thoughtSignature: 'SIG' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'write_file', response: { result: 'done' } } }, { text: 'now style it' }] },
  ]);
  assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'write_file', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }]);
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 99, thinkingConfig: { thinkingLevel: 'low' } });
});

test('a Gemini reply becomes a chat completion: text, tool calls with remembered signatures, and thinking tokens counted as output', () => {
  const signatures = new Map();
  const out = fromGemini({ candidates: [{ content: { parts: [{ text: 'Working.' }, { functionCall: { name: 'write_file', args: { path: 'a.html' } }, thoughtSignature: 'SIG9' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 } }, { signatures, model: 'gemini-3.8-flash' });
  const message = out.choices[0].message;
  assert.equal(out.choices[0].finish_reason, 'tool_calls'); assert.equal(message.content, 'Working.');
  assert.equal(message.tool_calls[0].function.name, 'write_file'); assert.equal(message.tool_calls[0].function.arguments, '{"path":"a.html"}');
  assert.equal(signatures.get(message.tool_calls[0].id), 'SIG9');
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 10 }, 'thinking tokens are billed, so they count');
  assert.equal(fromGemini({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }).choices[0].finish_reason, 'length');
  const chunks = [...chunksOf(out)];
  assert.equal(chunks.length, 2); assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0); assert.deepEqual(chunks[1].usage, out.usage);
});

test('Gemini 3 gets a named thinking level, earlier Flash models get a zero budget, Pro is left alone', () => {
  assert.deepEqual(generationConfig('gemini-3.8-flash', 50), { maxOutputTokens: 50, thinkingConfig: { thinkingLevel: 'low' } });
  assert.deepEqual(generationConfig('gemini-2.5-flash', 50), { maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(generationConfig('gemini-2.5-pro', 50), { maxOutputTokens: 50 });
  assert.equal(modelUrl('vertex/gemini-3.8-flash'), 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent');
});

test('the adapter sends the API key in a header, never in the URL, and round-trips a tool call', async t => {
  const seen = [];
  const server = createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'write_file', args: {} } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } })); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = server.address().port;
  // A connector that sends to the stand-in server instead of Google, so the real URL, header and body are still built.
  const { pinnedFetch } = await import('../provider/safe-http.js');
  const connector = (url, options) => pinnedFetch(new URL(`http://127.0.0.1:${port}${url.pathname}`), { ...options, address: '127.0.0.1' });
  const adapter = geminiNative({ apiKey: 'test-key', model: 'gemini-3.8-flash', connector, resolver: async () => [{ address: '8.8.8.8' }] });
  const out = await adapter.chat({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'go' }], tools, max_tokens: 20, stream: false });
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(seen[0].key, 'test-key'); assert.ok(!seen[0].url.includes('test-key'), 'the key is not in the URL');
  assert.ok(seen[0].url.endsWith(':generateContent'));
});

test('tool schemas are cut down to what Gemini accepts, so $schema and additionalProperties never reach it', () => {
  const body = toGemini({ model: 'gemini-3.8-flash', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'edit', description: 'edit a file',
    parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', description: 'where', $comment: 'nope', default: '' }, count: { type: ['integer', 'null'], minimum: 0 }, items: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { a: { type: 'string' } } } } } } } }] });
  assert.deepEqual(body.tools[0].functionDeclarations[0].parameters, { type: 'object', required: ['path'], properties: {
    path: { type: 'string', description: 'where' }, count: { type: 'integer', nullable: true, minimum: 0 }, items: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } } } });
});
