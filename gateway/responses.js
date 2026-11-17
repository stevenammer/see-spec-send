// OpenAI Responses API on top of the metered chat gateway.
//
// Codex (OpenAI's coding agent) no longer speaks the chat-completions protocol: it calls POST /v1/responses with its own
// item format and expects its own streaming events. This file translates that to the OpenAI-shaped chat request the
// gateway meters (see ChatGateway in ./http.js) and translates the answer back, so Codex can be pointed at the gateway and
// every call is still reserved, dispatched and settled on the same ledger, with the same caps and receipts. It adds no new
// way to spend money and keeps no provider key.
//
// Supported: text, function tools, function_call and function_call_output items, instructions, streaming. Tools the
// gateway cannot contain (web search, sub-agent namespaces, custom/freeform tools, hosted tools) are not passed on: the
// model is simply not offered them, so it cannot call them. Stateful features (previous_response_id, conversations,
// background mode, stored prompts) and images/files are refused, plainly.
import { randomBytes } from 'node:crypto';

export class ResponsesRefusal extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') { super(message); this.status = status; this.type = type; }
}

const IGNORED_KEYS = ['parallel_tool_calls', 'reasoning', 'store', 'include', 'prompt_cache_key', 'client_metadata', 'temperature', 'top_p',
  'text', 'truncation', 'metadata', 'user', 'service_tier', 'safety_identifier', 'stream_options', 'top_logprobs', 'max_tool_calls', 'prompt_cache_retention'];
const REFUSED_KEYS = ['previous_response_id', 'conversation', 'background', 'prompt'];
const KNOWN_KEYS = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'stream', 'max_output_tokens', ...IGNORED_KEYS];

const refuse = (message, status, type) => { throw new ResponsesRefusal(message, status, type); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const newId = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return refuse('content must be text or a list of text parts');
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (['input_text', 'output_text', 'text', 'summary_text'].includes(part?.type) && typeof part.text === 'string') return part.text;
    return refuse(`content part "${part?.type}" is not supported by this gateway (text only)`);
  }).join('');
}
const outputText = output => {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return textOf(output);
  if (isObject(output) && output.content !== undefined) return textOf(output.content);
  return output === undefined || output === null ? '' : JSON.stringify(output);
};

// Responses API request body -> the OpenAI-shaped chat request ChatGateway validates and meters.
export function responsesToChat(body) {
  if (!isObject(body)) refuse('the request body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (REFUSED_KEYS.includes(key)) refuse(`"${key}" is not supported by this gateway (it keeps no conversation state; send the full input each time)`);
    if (!KNOWN_KEYS.includes(key)) refuse(`the field "${key}" is not supported by this gateway`);
  }
  if (typeof body.model !== 'string' || !body.model) refuse('model is required');
  const systems = []; const messages = [];
  if (typeof body.instructions === 'string' && body.instructions) systems.push(body.instructions);
  const items = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(items) || items.length === 0) refuse('input must be text or a non-empty list of items');
  for (const item of items) {
    if (!isObject(item)) refuse('each input item must be an object');
    const type = item.type || (item.role ? 'message' : undefined);
    if (type === 'message') {
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) refuse('a message needs a role of user, assistant, system or developer');
      const text = textOf(item.content);
      if (item.role === 'system' || item.role === 'developer') { if (text) systems.push(text); }
      else messages.push({ role: item.role, content: text });
    } else if (type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string') refuse('function_call needs a call_id and a name');
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else if (last?.role === 'assistant' && !last.tool_calls) { last.tool_calls = [call]; }
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (type === 'function_call_output') {
      if (typeof item.call_id !== 'string') refuse('function_call_output needs a call_id');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: outputText(item.output) });
    } else if (type === 'reasoning') continue;
    else refuse(`the input item "${type}" is not supported by this gateway`);
  }
  if (systems.length) messages.unshift({ role: 'system', content: systems.join('\n\n') });
  const chat = { model: body.model, messages, stream: body.stream === true };
  if (body.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1) refuse('max_output_tokens must be a positive integer');
    chat.max_tokens = body.max_output_tokens;
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) refuse('tools must be a list');
    const functions = body.tools.filter(tool => tool?.type === 'function').map(tool => {
      if (typeof tool.name !== 'string' || !tool.name) refuse('a function tool needs a name');
      return { type: 'function', function: { name: tool.name, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), parameters: isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} } } };
    });
    if (functions.length) chat.tools = functions;
  }
  const choice = body.tool_choice;
  if (chat.tools && choice !== undefined) {
    if (choice === 'auto' || choice === 'none' || choice === 'required') chat.tool_choice = choice;
    else if (isObject(choice) && choice.type === 'function' && (choice.name || choice.function?.name)) chat.tool_choice = { type: 'function', function: { name: choice.name || choice.function.name } };
    else chat.tool_choice = 'auto';
  }
  return chat;
}

function usageOf(usage) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? 0, output = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const i = Number.isSafeInteger(input) ? input : 0, o = Number.isSafeInteger(output) ? output : 0;
  return { input_tokens: i, input_tokens_details: { cached_tokens: 0 }, output_tokens: o, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: i + o };
}
const baseResponse = (id, model, createdAt, status, output = [], usage = null, extra = {}) => ({ id, object: 'response', created_at: createdAt, status, model, output, usage, error: null, incomplete_details: null, ...extra });
const messageItem = (id, text, status = 'completed') => ({ id, type: 'message', status, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const callItem = (id, callId, name, args, status = 'completed') => ({ id, type: 'function_call', status, call_id: callId, name, arguments: args });

// A finished OpenAI-shaped chat completion -> a Responses API response object.
export function chatToResponse(result, model) {
  const choice = result?.choices?.[0]; const message = choice?.message || {};
  const output = [];
  if (typeof message.content === 'string' && message.content) output.push(messageItem(newId('msg'), message.content));
  for (const call of message.tool_calls || []) output.push(callItem(newId('fc'), call.id || newId('call'), call.function?.name || '', typeof call.function?.arguments === 'string' ? call.function.arguments : '{}'));
  if (output.length === 0) output.push(messageItem(newId('msg'), ''));
  const incomplete = choice?.finish_reason === 'length';
  return baseResponse(typeof result?.id === 'string' && result.id ? `resp_${result.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}` : newId('resp'), model, Math.floor(Date.now() / 1000),
    incomplete ? 'incomplete' : 'completed', output, usageOf(result?.usage), incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {});
}

// A stream of OpenAI-shaped chunks -> Responses API server-sent events. `emit(eventName, data)` writes one event.
export function responsesStream(model, emit) {
  const id = newId('resp'); const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0; let started = false; let ended = false; let finish = null; let usage = null;
  const output = []; let open = null; const tools = new Map();
  const send = (type, data) => emit(type, { type, sequence_number: sequence++, ...data });
  const start = () => { if (started) return; started = true; send('response.created', { response: baseResponse(id, model, createdAt, 'in_progress') }); send('response.in_progress', { response: baseResponse(id, model, createdAt, 'in_progress') }); };
  const close = () => {
    if (!open) return;
    if (open.kind === 'message') {
      send('response.output_text.done', { item_id: open.id, output_index: open.index, content_index: 0, text: open.text });
      send('response.content_part.done', { item_id: open.id, output_index: open.index, content_index: 0, part: { type: 'output_text', text: open.text, annotations: [] } });
      output[open.index] = messageItem(open.id, open.text);
    } else {
      send('response.function_call_arguments.done', { item_id: open.id, output_index: open.index, arguments: open.args });
      output[open.index] = callItem(open.id, open.callId, open.name, open.args);
    }
    send('response.output_item.done', { output_index: open.index, item: output[open.index] });
    open = null;
  };
  const openMessage = () => { close(); const index = output.length; output.push(null); open = { kind: 'message', id: newId('msg'), index, text: '' };
    send('response.output_item.added', { output_index: index, item: { id: open.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { item_id: open.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }); };
  const openCall = (callId, name) => { close(); const index = output.length; output.push(null); open = { kind: 'call', id: newId('fc'), index, callId, name, args: '' };
    send('response.output_item.added', { output_index: index, item: callItem(open.id, callId, name, '', 'in_progress') }); return open; };
  return {
    chunk(chunk) {
      if (ended) return;
      if (chunk?.error) { this.error(chunk.error.message || 'the gateway stopped the stream'); return; }
      start();
      if (chunk?.usage) usage = usageOf(chunk.usage);
      const choice = chunk?.choices?.[0]; const delta = choice?.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        if (!open || open.kind !== 'message') openMessage();
        open.text += delta.content;
        send('response.output_text.delta', { item_id: open.id, output_index: open.index, content_index: 0, delta: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        const key = call.index ?? 0;
        if (!tools.has(key) && (call.id || call.function?.name)) tools.set(key, openCall(call.id || newId('call'), call.function?.name || ''));
        const current = tools.get(key);
        if (current && call.function?.arguments) {
          current.args += call.function.arguments;
          send('response.function_call_arguments.delta', { item_id: current.id, output_index: current.index, delta: call.function.arguments });
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    },
    done() {
      if (ended) return; ended = true; start();
      if (output.length === 0) openMessage();
      close();
      const incomplete = finish === 'length';
      const response = baseResponse(id, model, createdAt, incomplete ? 'incomplete' : 'completed', output, usage || usageOf(null), incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {});
      send(incomplete ? 'response.incomplete' : 'response.completed', { response });
    },
    error(message) {
      if (ended) return; ended = true; start(); close();
      send('response.failed', { response: baseResponse(id, model, createdAt, 'failed', output.filter(Boolean), null, { error: { code: 'server_error', message: String(message).slice(0, 300) } }) });
    },
  };
}

export const errorBody = (message, type = 'server_error', code = null) => ({ error: { message: String(message).slice(0, 300), type, code } });
export function errorFor(error) {
  if (error instanceof ResponsesRefusal) return { status: error.status, body: errorBody(error.message, error.type) };
  const message = String(error?.message || '');
  if (/cap exceeded/.test(message)) return { status: 402, body: errorBody('the approved budget for this build is used up', 'insufficient_quota', 'budget_exceeded') };
  if (/concurrency/.test(message)) return { status: 429, body: errorBody('too many calls at once', 'rate_limit_exceeded') };
  if (/capability|stale|stopped/.test(message)) return { status: 403, body: errorBody('this build is no longer authorized', 'invalid_request_error', 'not_authorized') };
  if (/corrupt|verification|accounting/.test(message)) return { status: 503, body: errorBody('the gateway could not verify its own records', 'server_error') };
  return { status: 400, body: errorBody('the gateway refused this request', 'invalid_request_error') };
}
