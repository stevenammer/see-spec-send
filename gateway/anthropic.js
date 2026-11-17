// Anthropic Messages API on top of the metered chat gateway.
//
// The gateway meters one thing: an OpenAI-shaped chat request (see ChatGateway in ./http.js). Claude Code and the
// Anthropic SDKs speak Anthropic's Messages API instead. This file translates between the two, in both directions,
// so an agent that only speaks Anthropic's format can be pointed at the gateway and every call is still reserved,
// dispatched and settled against the same ledger, caps and receipts. It adds no new way to spend money and keeps no
// provider key: the translated request goes through exactly the path /v1/chat/completions uses.
//
// What is supported: text, tool definitions, tool_use and tool_result blocks, system prompts, streaming. What is
// refused, plainly: images, documents and server-side tools (web search, code execution), because the gateway
// cannot meter or contain them. Fields that only tune sampling or bookkeeping are accepted and dropped.
import { randomBytes } from 'node:crypto';

export class AnthropicRefusal extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') { super(message); this.status = status; this.type = type; }
}

const IGNORED_KEYS = ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata', 'thinking', 'service_tier', 'betas',
  'context_management', 'container', 'mcp_servers', 'output_config', 'cache_control'];
const KNOWN_KEYS = ['model', 'messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'stream', ...IGNORED_KEYS];

const refuse = (message, status, type) => { throw new AnthropicRefusal(message, status, type); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const textOf = blocks => blocks.map(block => {
  if (typeof block === 'string') return block;
  if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  return refuse(`content block "${block?.type}" is not supported by this gateway (text and tool blocks only)`);
}).join('\n');

// Anthropic request body -> the OpenAI-shaped request ChatGateway validates and meters.
export function anthropicToChat(body) {
  if (!isObject(body)) refuse('the request body must be a JSON object');
  for (const key of Object.keys(body)) if (!KNOWN_KEYS.includes(key)) refuse(`the field "${key}" is not supported by this gateway`);
  if (typeof body.model !== 'string' || !body.model) refuse('model is required');
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) refuse('max_tokens is required and must be a positive integer');
  if (!Array.isArray(body.messages) || body.messages.length === 0) refuse('messages must be a non-empty array');
  const messages = [];
  // Instructions from `system` and from any system-role entries are merged into one leading system message. Claude Code
  // adds a system-role entry to the message list when it does not recognize the model name (a custom label), and
  // every downstream provider takes its system text first.
  const systems = [];
  if (body.system !== undefined && body.system !== null) {
    const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? textOf(body.system) : refuse('system must be text');
    if (system) systems.push(system);
  }
  for (const message of body.messages) {
    if (!isObject(message) || !['user', 'assistant', 'system'].includes(message.role)) refuse('each message needs a role of user, assistant or system');
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) refuse('message content must be text or a list of blocks');
    if (message.role === 'system') {
      const text = textOf(blocks);
      if (text) systems.push(text);
    } else if (message.role === 'user') {
      const results = []; const texts = [];
      for (const block of blocks) {
        if (block?.type === 'tool_result') {
          if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) refuse('tool_result needs a tool_use_id');
          const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? textOf(block.content) : '';
          results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error ? `Error: ${content}` : content });
        } else texts.push(block);
      }
      // OpenAI wants tool results directly after the assistant turn that asked for them, then any new user text.
      messages.push(...results);
      const text = textOf(texts);
      if (text || results.length === 0) messages.push({ role: 'user', content: text });
    } else {
      const texts = []; const calls = [];
      for (const block of blocks) {
        if (block?.type === 'tool_use') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isObject(block.input)) refuse('tool_use needs an id, a name and an object input');
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
        } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
        else texts.push(block);
      }
      const text = textOf(texts);
      messages.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  if (systems.length) messages.unshift({ role: 'system', content: systems.join('\n\n') });
  const chat = { model: body.model, messages, max_tokens: body.max_tokens, stream: body.stream === true };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) refuse('tools must be a list');
    chat.tools = body.tools.map(tool => {
      if (!isObject(tool) || (tool.type !== undefined && tool.type !== 'custom') || typeof tool.name !== 'string' || !isObject(tool.input_schema))
        return refuse(`the tool "${tool?.name || tool?.type}" is not supported (only custom tools with an input_schema; no server-side tools)`);
      return { type: 'function', function: { name: tool.name, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), parameters: tool.input_schema } };
    });
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (!isObject(choice)) refuse('tool_choice must be an object');
    if (choice.type === 'auto') chat.tool_choice = 'auto';
    else if (choice.type === 'any') chat.tool_choice = 'required';
    else if (choice.type === 'none') chat.tool_choice = 'none';
    else if (choice.type === 'tool' && typeof choice.name === 'string') chat.tool_choice = { type: 'function', function: { name: choice.name } };
    else refuse('unsupported tool_choice');
  }
  return chat;
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
export const stopReason = reason => STOP[reason] || 'end_turn';
const newId = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;
export function usageOf(usage) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? 0, output = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  return { input_tokens: Number.isSafeInteger(input) ? input : 0, output_tokens: Number.isSafeInteger(output) ? output : 0 };
}
function parseArguments(text) {
  if (typeof text !== 'string' || !text.trim()) return {};
  try { const value = JSON.parse(text); return isObject(value) ? value : {}; } catch { return {}; }
}

// A finished OpenAI-shaped chat completion -> an Anthropic message.
export function chatToAnthropic(result, model) {
  const choice = result?.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls || []) {
    content.push({ type: 'tool_use', id: call.id || newId('toolu'), name: call.function?.name || '', input: parseArguments(call.function?.arguments) });
  }
  if (message.function_call?.name) content.push({ type: 'tool_use', id: newId('toolu'), name: message.function_call.name, input: parseArguments(message.function_call.arguments) });
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return { id: typeof result?.id === 'string' && result.id ? `msg_${result.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || randomBytes(8).toString('hex')}` : newId('msg'),
    type: 'message', role: 'assistant', model, content, stop_reason: stopReason(choice?.finish_reason), stop_sequence: null, usage: usageOf(result?.usage) };
}

// A stream of OpenAI-shaped chunks -> Anthropic server-sent events. `emit(eventName, data)` writes one event.
export function streamTranslator(model, emit) {
  let started = false; let index = -1; let open = null; let finish = null; let usage = { input_tokens: 0, output_tokens: 0 }; let ended = false;
  const tools = new Map();
  const start = id => { if (started) return; started = true; emit('message_start', { type: 'message_start', message: { id: typeof id === 'string' && id ? `msg_${id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}` : newId('msg'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }); emit('ping', { type: 'ping' }); };
  const close = () => { if (open !== null) { emit('content_block_stop', { type: 'content_block_stop', index: open }); open = null; } };
  const openBlock = (block) => { close(); index += 1; open = index; emit('content_block_start', { type: 'content_block_start', index, content_block: block }); return index; };
  let textIndex = null;
  return {
    chunk(chunk) {
      if (ended) return;
      if (chunk?.error) { this.error(chunk.error.message || 'the gateway stopped the stream'); return; }
      start(chunk?.id);
      const choice = chunk?.choices?.[0];
      if (chunk?.usage) usage = usageOf(chunk.usage);
      const delta = choice?.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        if (textIndex === null || open !== textIndex) textIndex = openBlock({ type: 'text', text: '' });
        emit('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const call of delta.tool_calls || []) {
        const key = call.index ?? 0;
        if (!tools.has(key) && (call.id || call.function?.name)) tools.set(key, openBlock({ type: 'tool_use', id: call.id || newId('toolu'), name: call.function?.name || '', input: {} }));
        const at = tools.get(key);
        if (at !== undefined && call.function?.arguments) emit('content_block_delta', { type: 'content_block_delta', index: at, delta: { type: 'input_json_delta', partial_json: call.function.arguments } });
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    },
    done() {
      if (ended) return; ended = true; start();
      if (index < 0) openBlock({ type: 'text', text: '' });
      close();
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(finish), stop_sequence: null }, usage });
      emit('message_stop', { type: 'message_stop' });
    },
    error(message) {
      if (ended) return; ended = true; start(); close();
      emit('error', { type: 'error', error: { type: 'api_error', message: String(message).slice(0, 300) } });
    },
  };
}

export const errorBody = (message, type = 'api_error') => ({ type: 'error', error: { type, message: String(message).slice(0, 300) } });
export function errorFor(error) {
  if (error instanceof AnthropicRefusal) return { status: error.status, body: errorBody(error.message, error.type) };
  const message = String(error?.message || '');
  if (/cap exceeded/.test(message)) return { status: 402, body: errorBody('the approved budget for this build is used up', 'billing_error') };
  if (/concurrency/.test(message)) return { status: 429, body: errorBody('too many calls at once', 'rate_limit_error') };
  if (/capability|stale|stopped/.test(message)) return { status: 403, body: errorBody('this build is no longer authorized', 'permission_error') };
  if (/corrupt|verification|accounting/.test(message)) return { status: 503, body: errorBody('the gateway could not verify its own records', 'api_error') };
  return { status: 400, body: errorBody('the gateway refused this request', 'invalid_request_error') };
}

// ---------------------------------------------------------------------------------------------------------------------
// The other direction, for the `anthropic` provider: the gateway holds the OpenAI-shaped chat request, and the upstream
// is Anthropic's own API. This lets an organization with an Anthropic key power any agent behind the gateway (including
// OpenCode, which speaks the OpenAI shape) without going through Bedrock.

const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('') : '';
function callInput(text) { try { const value = JSON.parse(text); return isObject(value) ? value : {}; } catch { return {}; } }

// OpenAI-shaped chat request -> Anthropic Messages request body.
export function chatToAnthropicRequest(request) {
  const systems = []; const messages = [];
  const addUser = block => { const last = messages.at(-1); if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block); else messages.push({ role: 'user', content: [block] }); };
  for (const message of request.messages || []) {
    if (message.role === 'system') { const text = contentText(message.content); if (text) systems.push(text); }
    else if (message.role === 'user') addUser({ type: 'text', text: contentText(message.content) });
    else if (message.role === 'tool') addUser({ type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content: contentText(message.content) });
    else if (message.role === 'assistant') {
      const blocks = []; const text = contentText(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) blocks.push({ type: 'tool_use', id: call.id || newId('toolu'), name: call.function?.name || '', input: callInput(call.function?.arguments) });
      if (message.function_call?.name) blocks.push({ type: 'tool_use', id: newId('toolu'), name: message.function_call.name, input: callInput(message.function_call.arguments) });
      messages.push({ role: 'assistant', content: blocks.length ? blocks : '' });
    }
  }
  // Tool results must lead the user turn that answers a tool call, ahead of any new text.
  for (const message of messages) if (message.role === 'user' && Array.isArray(message.content)) message.content.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
  const body = { model: request.model, max_tokens: request.max_tokens ?? 1024, messages };
  if (systems.length) body.system = systems.join('\n\n');
  const tools = request.tools ? request.tools.map(tool => tool.function) : request.functions;
  if (Array.isArray(tools) && tools.length) body.tools = tools.map(fn => ({ name: fn.name, ...(fn.description ? { description: fn.description } : {}), input_schema: isObject(fn.parameters) ? fn.parameters : { type: 'object' } }));
  const choice = request.tool_choice;
  if (body.tools && choice !== undefined) {
    if (choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (choice === 'required') body.tool_choice = { type: 'any' };
    else if (choice === 'none') delete body.tools;
    else if (choice?.function?.name) body.tool_choice = { type: 'tool', name: choice.function.name };
  }
  if (request.stream === true) body.stream = true;
  return body;
}

const CHAT_FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'stop' };
export const finishReason = reason => CHAT_FINISH[reason] || 'stop';

// A finished Anthropic message -> an OpenAI-shaped chat completion.
export function anthropicToChatResult(message) {
  const text = (message?.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('');
  const calls = (message?.content || []).filter(block => block?.type === 'tool_use').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(isObject(block.input) ? block.input : {}) } }));
  const { input_tokens: input, output_tokens: output } = usageOf(message?.usage);
  return { id: message?.id || newId('msg'), object: 'chat.completion', model: message?.model, choices: [{ index: 0, message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason(message?.stop_reason) }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}

// Parsed Anthropic stream events -> OpenAI-shaped chunks, ending with a usage chunk the gateway can settle on.
export async function* anthropicEventsToChunks(events) {
  let id = newId('msg'); let model; let input = 0; let output = 0; let finish = 'stop'; let tool = -1;
  const blocks = new Map(); let sentRole = false;
  const chunk = (delta, extra = {}) => ({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }], ...extra });
  for await (const event of events) {
    if (event?.type === 'message_start') { id = event.message?.id || id; model = event.message?.model; input = usageOf(event.message?.usage).input_tokens; output = usageOf(event.message?.usage).output_tokens; yield chunk({ role: 'assistant' }); sentRole = true; }
    else if (event?.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') { tool += 1; blocks.set(event.index, tool); yield chunk({ tool_calls: [{ index: tool, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }] }); }
    } else if (event?.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) yield chunk({ content: event.delta.text });
      else if (event.delta?.type === 'input_json_delta' && blocks.has(event.index)) yield chunk({ tool_calls: [{ index: blocks.get(event.index), function: { arguments: event.delta.partial_json || '' } }] });
    } else if (event?.type === 'message_delta') {
      if (event.delta?.stop_reason) finish = finishReason(event.delta.stop_reason);
      const u = usageOf(event.usage); if (u.output_tokens) output = u.output_tokens; if (u.input_tokens) input = u.input_tokens;
    } else if (event?.type === 'error') throw new Error(`provider stream error: ${String(event.error?.type || 'error').slice(0, 60)}`);
  }
  if (!sentRole) yield chunk({ role: 'assistant' });
  yield { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}
