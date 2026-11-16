import test from 'node:test';
import assert from 'node:assert/strict';
import { signV4, toConverse, fromConverse } from '../provider/bedrock.js';

test('SigV4 is deterministic, signs the body and the doubly-encoded path, and carries a session token', () => {
  const base = { method: 'POST', host: 'bedrock-runtime.us-east-1.amazonaws.com', path: '/model/us.amazon.nova-lite-v1%3A0/converse',
    body: '{"a":1}', region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2026-11-16T12:00:00Z') };
  const a = signV4(base), b = signV4(base);
  assert.deepEqual(a, b);
  assert.match(a.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261116\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.notEqual(signV4({ ...base, body: '{"a":2}' }).authorization, a.authorization, 'the body is signed');
  const withToken = signV4({ ...base, sessionToken: 'tok' });
  assert.match(withToken.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  assert.equal(withToken['x-amz-security-token'], 'tok');
  assert.ok(!JSON.stringify(a).includes('wJalrXUt'), 'the secret never appears in the headers');
});

test('chat messages translate to Converse: system split out, tool calls and results paired, results merged', () => {
  const body = toConverse({ max_tokens: 50, messages: [
    { role: 'system', content: 'Be brief.' }, { role: 'user', content: 'read a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }, { id: 't2', type: 'function', function: { name: 'read_file', arguments: 'not json' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'A' }, { role: 'tool', tool_call_id: 't2', content: 'B' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }] });
  assert.deepEqual(body.system, [{ text: 'Be brief.' }]);
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].content[0].toolUse.toolUseId, 't1');
  assert.deepEqual(body.messages[1].content[1].toolUse.input, {}, 'malformed arguments become an empty object, never a crash');
  assert.equal(body.messages[2].role, 'user'); assert.equal(body.messages[2].content.length, 2, 'adjacent tool results share one user turn');
  assert.equal(body.inferenceConfig.maxTokens, 50);
  assert.equal(body.toolConfig.tools[0].toolSpec.name, 'read_file');
});

test('Converse results translate back, including tool calls, length stops and usage', () => {
  const tool = fromConverse({ output: { message: { content: [{ toolUse: { toolUseId: 'x', name: 'read_file', input: { path: 'a' } } }] } }, stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }, 'm');
  assert.equal(tool.finish_reason, 'tool_calls'); assert.equal(tool.message.tool_calls[0].function.arguments, '{"path":"a"}');
  assert.deepEqual(tool.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.equal(fromConverse({ output: { message: { content: [{ text: 'hi' }] } }, stopReason: 'max_tokens', usage: {} }, 'm').finish_reason, 'length');
});
