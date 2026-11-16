import { spawn } from 'node:child_process';
import { jsonRequest, resolvePinned, pinnedFetch } from './safe-http.js';
import { validateCompletion } from './index.js';

const auth = config => config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
const text = value => typeof value === 'string' ? value : value?.map?.(part => part.text || '').join('') || '';
const usage = (value, input = 'prompt_tokens', output = 'completion_tokens') => ({ inputTokens: value?.[input], outputTokens: value?.[output] });
export function openAICompatible(config) { return { async complete(request) {
  const data = await jsonRequest(config.url, { ...config, headers: auth(config), body: { model: request.model, messages: [
    ...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages], max_tokens: request.maxOutputTokens }, signal: request.signal });
  return validateCompletion({ text: text(data.choices?.[0]?.message?.content), usage: usage(data.usage) });
}, async chat(request) {
  const body = { model: request.model, messages: request.messages, tools: request.tools,
    tool_choice: request.tool_choice, functions: request.functions, function_call: request.function_call,
    max_tokens: request.max_tokens, stream: request.stream };
  if (!request.stream) return jsonRequest(config.url, { ...config, headers: auth(config), body, signal: request.signal });
  const pin = await resolvePinned(config.url, config);
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > (config.requestBytes || 128 * 1024)) throw Error('provider request byte limit');
  const signal = AbortSignal.any([request.signal || new AbortController().signal, AbortSignal.timeout(config.timeoutMs || 10_000)]);
  const response = await pinnedFetch(pin.url, { address: pin.address, family: pin.family, method: 'POST', signal,
    headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...auth(config) }, body: encoded });
  if (!response.ok || !response.body) throw Error(`provider HTTP ${response.status}`);
  return (async function* () {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let bytes = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > (config.responseBytes || 128 * 1024)) { await reader.cancel(); throw Error('provider response byte limit'); }
      pending += decoder.decode(value, { stream: true }); let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (!data) continue; if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { throw Error('provider returned malformed SSE'); }
      }
    }
  })();
} }; }
export function anthropicMessages(config) { return { async complete(request) {
  const data = await jsonRequest(config.url, { ...config, headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }, body: { model: request.model, system: request.system, messages: request.messages, max_tokens: request.maxOutputTokens }, signal: request.signal });
  return validateCompletion({ text: text(data.content), usage: usage(data.usage, 'input_tokens', 'output_tokens') });
} }; }
export function geminiGenerateContent(config) { return { async complete(request) {
  const data = await jsonRequest(config.url, { ...config, headers: config.apiKey ? { 'x-goog-api-key': config.apiKey } : {}, body: { system_instruction: request.system ? { parts: [{ text: request.system }] } : undefined, contents: request.messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), generationConfig: { maxOutputTokens: request.maxOutputTokens } }, signal: request.signal });
  return validateCompletion({ text: text(data.candidates?.[0]?.content?.parts), usage: usage(data.usageMetadata, 'promptTokenCount', 'candidatesTokenCount') });
} }; }
export function webhook(config) { return { async complete(request) {
  const data = await jsonRequest(config.url, { ...config, headers: auth(config), body: request, signal: request.signal });
  return validateCompletion(data);
} }; }
export function localCommand(config) { return { async complete(request) {
  if (!Array.isArray(config.command) || !config.command.length || !config.command.every(part => typeof part === 'string' && part)) throw Error('local command required');
  const cap = config.responseBytes || 128 * 1024; const timeout = config.timeoutMs || 10_000;
  if (request.signal?.aborted) throw Error('local command aborted');
  return await new Promise((resolve, reject) => {
    let done = false; let output = Buffer.alloc(0); let stderr = Buffer.alloc(0);
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); request.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const child = spawn(config.command[0], config.command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      // An org's executable gets a minimal environment, never the server's API keys or other secrets.
      env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
    const abort = () => { child.kill('SIGKILL'); finish(Error('local command aborted')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error('local command timeout')); }, timeout);
    const collect = (chunk, stream) => {
      const next = Buffer.concat([stream, chunk]);
      if (next.length > cap) { child.kill('SIGKILL'); finish(Error('local command output limit')); return stream; }
      return next;
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { output = collect(chunk, output); });
    child.stderr.on('data', chunk => { stderr = collect(chunk, stderr); });
    child.on('error', () => finish(Error('local command failed')));
    child.on('close', code => {
      if (code !== 0) return finish(Error('local command failed'));
      try { finish(null, validateCompletion(JSON.parse(output.toString('utf8')))); }
      catch { finish(Error('local command returned malformed JSON')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
} }; }
export const adapters = Object.freeze({ openai: openAICompatible, anthropic: anthropicMessages, gemini: geminiGenerateContent, webhook, command: localCommand });
