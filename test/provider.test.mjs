import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openAICompatible, anthropicMessages, geminiGenerateContent, webhook, localCommand } from '../provider/adapters.js';
import { providerConformance } from '../provider/index.js';
import { checkedUrl, redact } from '../provider/safe-http.js';
import { readProviders, saveProviders, providerFor } from '../provider/config.js';
import { validateProvider } from '../provider/config.js';

const listen = async (t, handler) => { const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close()); return `http://127.0.0.1:${server.address().port}`; };
const request = { system: 'S', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 2, model: 'm' };
const ok = (res, body) => res.end(JSON.stringify(body));
test('wire adapters and webhook conform through local HTTP only', async t => {
  const url = await listen(t, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; assert.ok(body);
    if (req.url === '/429') { res.statusCode = 429; return res.end(); }
    if (req.url === '/500') { res.statusCode = 500; return res.end(); }
    if (req.url === '/bad') return res.end('{');
    if (req.url === '/large') return ok(res, { choices: [{ message: { content: 'o' } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, pad: 'x'.repeat(2048) });
    if (req.url === '/slow') return setTimeout(() => ok(res, { text: 'late', usage: { inputTokens: 1, outputTokens: 1 } }), 100);
    if (req.url === '/drop') return res.destroy();
    if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', '/'); return res.end(); }
    if (req.url === '/anthropic') return ok(res, { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 1, output_tokens: 1 } });
    if (req.url === '/gemini') return ok(res, { candidates: [{ content: { parts: [{ text: 'g' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    if (req.url === '/webhook') return ok(res, { text: 'w', usage: { inputTokens: 1, outputTokens: 1 } });
    if (req.url === '/missing') return ok(res, { text: 'missing usage' });
    ok(res, { choices: [{ message: { content: 'o' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const config = path => ({ url: `${url}${path}`, hosts: ['127.0.0.1'], allowPrivate: true, timeoutMs: 50, responseBytes: 1024 });
  // The first fetch in a process pays one-time setup that can exceed the 50 ms budget on a busy host.
  // One unbudgeted warm-up request keeps the timed loop below about the request under test.
  await openAICompatible({ ...config('/'), timeoutMs: 5000 }).complete(request);
  for (const [factory, path, expected] of [[openAICompatible, '/', 'o'], [anthropicMessages, '/anthropic', 'a'], [geminiGenerateContent, '/gemini', 'g'], [webhook, '/webhook', 'w']]) {
    const value = await factory(config(path)).complete(request); assert.equal(value.text, expected);
  }
  for (const path of ['/429', '/500', '/bad', '/large', '/slow', '/drop', '/redirect']) await assert.rejects(() => openAICompatible(config(path)).complete(request));
  await assert.rejects(() => webhook(config('/missing')).complete(request));
  await assert.rejects(() => checkedUrl(`${url}/`, { hosts: ['wrong.example'], allowPrivate: true }));
  await assert.rejects(() => checkedUrl('https://user:secret@example.com/', { hosts: ['example.com'] }));
  await providerConformance(() => webhook(config('/webhook')));
});
test('command adapter conforms and config never stores a credential', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-provider-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, 'command.mjs'); writeFileSync(command, "process.stdout.end(JSON.stringify({text:'ok',usage:{inputTokens:1,outputTokens:1}}))");
  await providerConformance(() => localCommand({ command: [process.execPath, command] }));
  const env = { SSS_PROVIDERS_FILE: join(dir, 'sss.providers.json'), KEY: 'not-on-disk' };
  saveProviders({ providers: [{ name: 'local', kind: 'command', model: 'local', enabled: true, command: [process.execPath, command], price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } }], defaults: { acme: 'local' } }, env);
  chmodSync(env.SSS_PROVIDERS_FILE, 0o600); assert.equal((await providerFor('local', env).complete(request)).text, 'ok');
  assert.equal(readProviders(env).defaults.acme, 'local'); assert.equal((await import('node:fs')).readFileSync(env.SSS_PROVIDERS_FILE, 'utf8').includes('not-on-disk'), false);
  const slow = join(dir, 'slow.mjs'); writeFileSync(slow, 'setTimeout(()=>{},1000)');
  const large = join(dir, 'large.mjs'); writeFileSync(large, "process.stdout.end('x'.repeat(4096))");
  await assert.rejects(() => localCommand({ command: [process.execPath, slow], timeoutMs: 10 }).complete(request), /timeout/);
  await assert.rejects(() => localCommand({ command: [process.execPath, large], responseBytes: 64 }).complete(request), /output/);
});
test('a provider needs an explicit integer price table', () => {
  assert.throws(() => validateProvider({ name: 'no-price', kind: 'command', model: 'm', enabled: true }), /priced/);
  assert.throws(() => validateProvider({ name: 'fraction', kind: 'command', model: 'm', enabled: true,
    price: { inputMicrosPerMillion: 1.5, outputMicrosPerMillion: 0 } }), /priced/);
  assert.equal(redact('Authorization: bearer-secret'), 'Authorization=[redacted]');
});

test('local command adapter never inherits the server environment or its API keys', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-provider-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'env.mjs');
  writeFileSync(script, "process.stdout.end(JSON.stringify({text:Object.keys(process.env).join(','),usage:{inputTokens:1,outputTokens:1}}))");
  process.env.SSS_TEST_SECRET_KEY = 'must-not-leak'; t.after(() => { delete process.env.SSS_TEST_SECRET_KEY; });
  const result = await localCommand({ command: [process.execPath, script] }).complete({ system: '', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 8, model: 'm' });
  assert.doesNotMatch(result.text, /SSS_TEST_SECRET_KEY/);
});
