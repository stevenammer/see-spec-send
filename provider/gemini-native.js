// Gemini on Vertex AI through its native generateContent endpoint, signed with an API key (Vertex's express mode).
// That endpoint doesn't speak the OpenAI chat format, and API keys aren't accepted by Vertex's OpenAI-compatible one,
// so this translates both ways: messages, system text, tool definitions, tool calls and tool results in, and a chat
// completion (or a short stream of chunks) out. Usage counts thinking tokens as output, because they are billed.
import { randomBytes } from 'node:crypto';
import { jsonRequest, pinnedFetch } from './safe-http.js';
import { validateCompletion } from './index.js';

const HOST = 'aiplatform.googleapis.com';
const realModel = model => String(model || '').replace(/^(google|vertex)\//, '');
const asText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text ?? '').join('') : '';
export const modelUrl = model => `https://${HOST}/v1/publishers/google/models/${encodeURIComponent(realModel(model))}:generateContent`;

// Gemini 3 takes a named thinking level and no sampling controls. Earlier models take a numeric budget.
export function generationConfig(model, maxTokens, level = 'low') {
  const config = { maxOutputTokens: maxTokens };
  if (/^gemini-3(?:\.|$)/.test(realModel(model))) config.thinkingConfig = { thinkingLevel: level };
  else if (!/pro/i.test(realModel(model))) config.thinkingConfig = { thinkingBudget: 0 };
  return config;
}

// Gemini accepts a small subset of JSON Schema for tool parameters and rejects the rest ($schema, additionalProperties,
// $ref and so on) with a 400. Keep only what it understands, and turn a "may be null" type into nullable.
const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minimum', 'maximum', 'minItems', 'maxItems', 'title']);
export function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cleanSchema(child)]));
    else if (key === 'type' && Array.isArray(value)) { const real = value.filter(type => type !== 'null'); out.type = real[0] || 'string'; if (value.includes('null')) out.nullable = true; }
    else if (key === 'anyOf' && Array.isArray(value)) out.anyOf = value.map(cleanSchema);
    else if (SCHEMA_KEYS.has(key)) out[key] = key === 'items' ? cleanSchema(value) : value;
  }
  return out;
}

// OpenAI chat messages -> Gemini contents. `names` maps a tool call id to its function name, and `signatures` maps it
// to the thought signature Gemini 3 wants echoed back with its function calls.
export function toGemini(request, { signatures = new Map(), level = 'low' } = {}) {
  const system = []; const contents = []; const names = new Map();
  const push = (role, parts) => { if (!parts.length) return; const last = contents.at(-1); if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts }); };
  for (const message of request.messages || []) {
    if (message.role === 'system') { system.push(asText(message.content)); continue; }
    if (message.role === 'tool') {
      push('user', [{ functionResponse: { name: names.get(message.tool_call_id) || 'tool', response: { result: asText(message.content) } } }]);
      continue;
    }
    if (message.role === 'assistant') {
      const parts = []; const text = asText(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls || []) {
        names.set(call.id, call.function.name);
        let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        const signature = signatures.get(call.id);
        parts.push({ functionCall: { name: call.function.name, args }, ...(signature ? { thoughtSignature: signature } : {}) });
      }
      push('model', parts); continue;
    }
    push('user', [{ text: asText(message.content) }]);
  }
  const functions = (request.tools || []).filter(tool => tool?.type === 'function').map(tool => ({ name: tool.function.name, description: tool.function.description || '', parameters: cleanSchema(tool.function.parameters) || { type: 'object', properties: {} } }));
  const choice = request.tool_choice;
  const mode = choice === 'none' ? 'NONE' : choice === 'required' || (choice && typeof choice === 'object') ? 'ANY' : 'AUTO';
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
    ...(functions.length ? { tools: [{ functionDeclarations: functions }], toolConfig: { functionCallingConfig: { mode, ...(choice?.function?.name ? { allowedFunctionNames: [choice.function.name] } : {}) } } } : {}),
    generationConfig: generationConfig(request.model, request.max_tokens ?? request.maxOutputTokens, level),
  };
}

// Gemini response -> an OpenAI chat completion. Function calls get fresh ids, and their signatures are remembered.
export function fromGemini(data, { signatures = new Map(), model = 'gemini' } = {}) {
  const candidate = data?.candidates?.[0]; const parts = candidate?.content?.parts || [];
  const text = parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
  const calls = parts.filter(part => part.functionCall).map(part => {
    const id = `call_${randomBytes(9).toString('base64url')}`;
    if (part.thoughtSignature) { signatures.set(id, part.thoughtSignature); if (signatures.size > 500) signatures.delete(signatures.keys().next().value); }
    return { id, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } };
  });
  const meta = data?.usageMetadata || {};
  const usage = { prompt_tokens: meta.promptTokenCount ?? 0, completion_tokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
  const finish = calls.length ? 'tool_calls' : candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
  return { id: `chatcmpl-${randomBytes(6).toString('hex')}`, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage };
}

// A stream is the finished answer cut into the chunks a streaming client expects, with usage on the last one.
export function* chunksOf(completion) {
  const choice = completion.choices[0]; const base = { id: completion.id, object: 'chat.completion.chunk', model: completion.model };
  const delta = { role: 'assistant', ...(choice.message.content ? { content: choice.message.content } : {}),
    ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
  yield { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
  yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: completion.usage };
}

export function geminiNative(config) {
  const signatures = new Map();
  const send = async request => {
    const model = request.model || config.model;
    // Optional debugging: onHttpError({ status, text }) receives Google's own error text, which jsonRequest otherwise hides.
    const connector = config.onHttpError ? async (url, options) => { const response = await (config.connector || pinnedFetch)(url, options);
      if (response.ok) return response; const text = await new Response(response.body).text(); config.onHttpError({ status: response.status, text }); return { ok: false, status: response.status, body: null }; } : config.connector;
    const data = await jsonRequest(modelUrl(model), { hosts: [HOST], allowPrivate: config.allowPrivate, resolver: config.resolver, connector, headers: { 'x-goog-api-key': config.apiKey },
      body: toGemini({ ...request, model }, { signatures, level: config.thinkingLevel }), timeoutMs: config.timeoutMs || 120_000, requestBytes: config.requestBytes || 700_000, responseBytes: config.responseBytes || 1_000_000, signal: request.signal });
    return fromGemini(data, { signatures, model });
  };
  return {
    async complete(request) {
      const completion = await send({ model: request.model, messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages], max_tokens: request.maxOutputTokens, signal: request.signal });
      return validateCompletion({ text: completion.choices[0].message.content || '', usage: { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens } });
    },
    async chat(request) {
      const completion = await send({ ...request, signal: request.signal });
      return request.stream ? (async function* () { yield* chunksOf(completion); })() : completion;
    },
  };
}
