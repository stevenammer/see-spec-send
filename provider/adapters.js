import { spawn } from 'node:child_process';
import { jsonRequest } from './safe-http.js';
import { validateCompletion } from './index.js';

const auth = config => config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
const text = value => typeof value === 'string' ? value : value?.map?.(part => part.text || '').join('') || '';
const usage = (value, input = 'prompt_tokens', output = 'completion_tokens') => ({ inputTokens: value?.[input], outputTokens: value?.[output] });
export function openAICompatible(config) { return { async complete(request) {
  const data = await jsonRequest(config.url, { ...config, headers: auth(config), body: { model: request.model, messages: [
    ...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages], max_tokens: request.maxOutputTokens }, signal: request.signal });
  return validateCompletion({ text: text(data.choices?.[0]?.message?.content), usage: usage(data.usage) });
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
  return await new Promise((resolve, reject) => {
    let done = false; let output = Buffer.alloc(0); let stderr = Buffer.alloc(0);
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); config.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
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
    config.signal?.addEventListener('abort', abort, { once: true });
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
