// Amazon Bedrock (Converse API) behind the same chat() seam as the other
// adapters. The caller supplies short-lived credentials from its own
// environment at run time; nothing here reads, stores or logs a secret.
import { createHash, createHmac } from 'node:crypto';
import { resolvePinned, pinnedFetch } from './safe-http.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// AWS Signature Version 4. For this service the canonical path is URI-encoded a
// second time, so a ":" in a model id is signed as %253A while sent as %3A.
export function signV4({ method, host, path, body, region, service = 'bedrock', accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const amz = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amz.slice(0, 8);
  const canonicalPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const headers = { host, 'x-amz-date': amz, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) };
  const names = Object.keys(headers).sort();
  const canonical = [method, canonicalPath, '', ...names.map(name => `${name}:${headers[name]}`), '', names.join(';'), sha256(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const text = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('') : '';

// OpenAI-style chat request -> Converse request.
export function toConverse(request) {
  const system = request.messages.filter(m => m.role === 'system').map(m => ({ text: text(m.content) })).filter(m => m.text);
  const messages = [];
  const push = (role, block) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...block); else messages.push({ role, content: [...block] });
  };
  for (const m of request.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') push('user', [{ toolResult: { toolUseId: m.tool_call_id, content: [{ text: text(m.content) || ' ' }] } }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (text(m.content)) blocks.push({ text: text(m.content) });
      for (const call of m.tool_calls || []) {
        let input = {}; try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
        blocks.push({ toolUse: { toolUseId: call.id, name: call.function?.name, input } });
      }
      push('assistant', blocks.length ? blocks : [{ text: ' ' }]);
    } else push('user', [{ text: text(m.content) || ' ' }]);
  }
  const body = { messages, ...(system.length ? { system } : {}), inferenceConfig: { maxTokens: request.max_tokens } };
  if (Array.isArray(request.tools) && request.tools.length) {
    body.toolConfig = { tools: request.tools.filter(tool => tool.type === 'function').map(tool => ({ toolSpec: {
      name: tool.function.name, description: tool.function.description || tool.function.name,
      inputSchema: { json: tool.function.parameters || { type: 'object', properties: {} } } } })) };
  }
  return body;
}

// Converse response -> OpenAI-style message, finish reason and usage.
export function fromConverse(result, model) {
  const blocks = result.output?.message?.content || [];
  const content = blocks.filter(b => typeof b.text === 'string').map(b => b.text).join('');
  const tool_calls = blocks.filter(b => b.toolUse).map((b, index) => ({ index, id: b.toolUse.toolUseId, type: 'function',
    function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) } }));
  const finish_reason = tool_calls.length ? 'tool_calls' : result.stopReason === 'max_tokens' ? 'length' : 'stop';
  const usage = { prompt_tokens: result.usage?.inputTokens, completion_tokens: result.usage?.outputTokens,
    total_tokens: result.usage?.totalTokens };
  return { message: { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason, usage, model };
}

export function bedrockConverse({ region, modelId, credentials, hosts, timeoutMs = 120_000, requestBytes = 700_000, responseBytes = 1_000_000, clock = () => new Date() }) {
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  async function call(request) {
    const body = JSON.stringify(toConverse(request));
    if (Buffer.byteLength(body) > requestBytes) throw Error('provider request byte limit');
    const path = `/model/${encodeURIComponent(modelId)}/converse`;
    const url = `https://${host}${path}`;
    const pin = await resolvePinned(url, { hosts: hosts || [host] });
    const headers = signV4({ method: 'POST', host, path, body, region, ...credentials, now: clock() });
    const signal = AbortSignal.any([request.signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
    const response = await pinnedFetch(pin.url, { address: pin.address, family: pin.family, method: 'POST', signal,
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, body });
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
      if (bytes > responseBytes) { await reader.cancel(); throw Error('provider response byte limit'); } chunks.push(value); }
    if (!response.ok) throw Error(`provider HTTP ${response.status}`);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return { async chat(request) {
    const out = fromConverse(await call(request), request.model);
    const id = `chatcmpl-${sha256(JSON.stringify(out.message)).slice(0, 24)}`;
    if (!request.stream) return { id, object: 'chat.completion', model: out.model,
      choices: [{ index: 0, message: out.message, finish_reason: out.finish_reason }], usage: out.usage };
    // One settled upstream answer is replayed as a short chunk stream.
    return (async function* () {
      yield { id, object: 'chat.completion.chunk', model: out.model, choices: [{ index: 0, delta: { role: 'assistant', content: out.message.content || '',
        ...(out.message.tool_calls ? { tool_calls: out.message.tool_calls } : {}) }, finish_reason: null }] };
      yield { id, object: 'chat.completion.chunk', model: out.model, choices: [{ index: 0, delta: {}, finish_reason: out.finish_reason }], usage: out.usage };
    })();
  } };
}
