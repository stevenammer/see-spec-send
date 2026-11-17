import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Ledger, rateWithSystemText } from './ledger.js';
import { anthropicToChat, chatToAnthropic, errorBody, errorFor, streamTranslator } from './anthropic.js';
import { chatToResponse, errorBody as responsesErrorBody, errorFor as responsesErrorFor, responsesStream, responsesToChat } from './responses.js';

const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};
async function body(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('request byte limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const unsafe = value => value && typeof value === 'object' && (Object.hasOwn(value, '__proto__')
  || Object.hasOwn(value, 'constructor') || Object.hasOwn(value, 'prototype')
  || Object.values(value).some(unsafe));
const chatKeys = ['function_call', 'functions', 'max_tokens', 'messages', 'model', 'stream', 'tool_choice', 'tools'];
// Real agents send sampling and bookkeeping parameters the gateway does not need.
// These exact keys are accepted and dropped; anything else is still refused.
const ignorableKeys = ['temperature', 'top_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty',
  'parallel_tool_calls', 'user', 'stream_options', 'max_completion_tokens', 'n'];
const proxyInput = request => ({ model: request.model, input: JSON.stringify({
  messages: request.messages, tools: request.tools, tool_choice: request.tool_choice,
  functions: request.functions, function_call: request.function_call,
}), max_output_tokens: request.max_tokens });
function validateChat(raw, ledger) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' || unsafe(raw)) throw Error('invalid chat payload');
  if (Object.keys(raw).some(key => !chatKeys.includes(key) && !ignorableKeys.includes(key))) throw Error('invalid chat payload');
  if (raw.n !== undefined && raw.n !== 1) throw Error('invalid chat payload');
  if (raw.stream_options !== undefined && !(raw.stream_options && typeof raw.stream_options === 'object'
    && Object.keys(raw.stream_options).every(key => key === 'include_usage') )) throw Error('invalid chat payload');
  const policy = ledger.policy();
  const request = Object.fromEntries(Object.entries(raw).filter(([key]) => chatKeys.includes(key)));
  // A missing or oversized output limit is clamped to the reviewed policy, never exceeded.
  const asked = request.max_tokens ?? raw.max_completion_tokens ?? policy.output_tokens;
  if (!Number.isSafeInteger(asked) || asked < 1) throw Error('invalid chat payload');
  request.max_tokens = Math.min(asked, policy.output_tokens);
  if (request.model !== ledger.rate.model || !Array.isArray(request.messages) || request.messages.length === 0
    || typeof request.stream !== 'boolean') throw Error('invalid chat payload');
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > policy.input_bytes) throw Error('chat limit');
  return { request, input: proxyInput(request) };
}

export class Gateway {
  constructor(ledger, provider) {
    this.ledger = ledger;
    this.provider = provider;
  }

  async call(raw, idem, input) {
    if (typeof this.provider !== 'function') throw new Error('no provider configured');
    const { row, fresh } = this.ledger.reserve(raw, idem, input);
    if (!fresh) return this.ledger.outcome(row.id);
    if (!this.ledger.dispatch(raw, row.id)) return this.ledger.outcome(row.id);
    // Dispatch is durable before the provider sees anything. No credential is passed to it.
    // Exceptions and timeouts never establish zero usage. A later valid result can still settle.
    let timer;
    let response;
    try { response = this.provider(Object.freeze({ ...input }), { id: row.id }); } catch { response = null; }
    const work = Promise.resolve(response)
      .then(result => this.ledger.settle(row.id, result)).catch(() => false);
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, JSON.parse(row.policy).timeout_ms); });
    try {
      await Promise.race([work, timeout]);
      return this.ledger.outcome(row.id);
    } finally { clearTimeout(timer); }
  }
}

// This is intentionally a separate protocol entry point, but not a separate
// ledger: every chat completion uses the same reserve/dispatch/settle receipt
// and original-approval cap as /v1/generate.
// Providers report usage as OpenAI-style prompt/completion tokens; the ledger
// settles on input/output tokens. Anything else stays as-is and fails closed.
export function normalizeUsage(usage) {
  if (usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)
    && usage.input_tokens === undefined && usage.output_tokens === undefined)
    return { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens };
  return usage;
}

export class ChatGateway {
  constructor(ledger, provider) { this.ledger = ledger; this.provider = provider; }

  async call(raw, idem, request) {
    if (!this.provider || typeof this.provider.chat !== 'function') throw Error('no chat provider configured');
    const { request: clean, input } = validateChat(request, this.ledger);
    request = clean;
    const { row, fresh } = this.ledger.reserve(raw, idem, input);
    if (!fresh) return this.ledger.outcome(row.id);
    if (!this.ledger.dispatch(raw, row.id)) return this.ledger.outcome(row.id);
    let timer; let response;
    try {
      const controller = new AbortController();
      response = this.provider.chat(Object.freeze({ ...request, stream: false }), { id: row.id, signal: controller.signal });
      const work = Promise.resolve(response).then(result => Promise.resolve(this.ledger.settle(row.id,
        { output: JSON.stringify(result), usage: normalizeUsage(result?.usage) }, { retainOutput: false })).then(ok => ok ? result : null)).catch(() => null);
      const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, JSON.parse(row.policy).timeout_ms); });
      const result = await Promise.race([work, timeout]);
      return result ? { status: 200, body: result } : this.ledger.outcome(row.id);
    } finally { clearTimeout(timer); }
  }

  async stream(raw, idem, request, send, begin = () => {}) {
    if (!this.provider || typeof this.provider.chat !== 'function') throw Error('no chat provider configured');
    const { request: clean, input } = validateChat(request, this.ledger);
    request = clean;
    const { row, fresh } = this.ledger.reserve(raw, idem, input);
    if (!fresh || !this.ledger.dispatch(raw, row.id)) throw Error('idempotency request is not dispatchable');
    // Only now is the call authorized and charged, so only now may the response
    // become a 200 event stream. Earlier refusals are ordinary HTTP errors.
    begin();
    const controller = new AbortController();
    let usage = null;
    try {
      const source = await this.provider.chat(Object.freeze({ ...request, stream: true }), { id: row.id, signal: controller.signal });
      for await (const chunk of source) {
        // Permission is rechecked before every provider chunk. Revocation,
        // expiry, kill, or stale approval aborts the upstream stream.
        this.ledger.authorize(raw); if (chunk?.usage) usage = normalizeUsage(chunk.usage);
        send(chunk);
      }
      if (!usage) throw Error('missing usage');
      if (!this.ledger.settle(row.id, { output: '', usage }, { retainOutput: false })) throw Error('stream not settleable');
      send('[DONE]');
    } catch (error) {
      controller.abort();
      send({ error: { message: 'gateway stream aborted', type: 'gateway_refusal' } }); send('[DONE]');
    }
  }
}

// This keeps provider credentials outside the ledger and turns the narrow
// completion contract into the legacy gateway response shape. Construct the
// Ledger with the matching provider/config priceRate before exposing this path.
export function providerGateway(ledger, provider, options) {
  const system = options?.system ?? '';
  const boundedLedger = new Ledger(ledger.store, { clock: ledger.clock, rate: rateWithSystemText(ledger.rate, system) });
  return new Gateway(boundedLedger, async input => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ledger.policy().timeout_ms);
    try {
      const result = await provider.complete({ system,
        messages: [{ role: 'user', content: input.input }], maxOutputTokens: input.max_output_tokens,
        model: input.model, signal: controller.signal });
      return { output: result.text, usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens } };
    } finally { clearTimeout(timeout); }
  });
}

// Anthropic Messages API entry point (for Claude Code and the Anthropic SDKs). It translates to the OpenAI-shaped chat
// request and goes through ChatGateway, so it is reserved, dispatched and settled on the same ledger as every other call.
async function handleMessages(req, res, path, chatGateway) {
  const fail = (status, body) => { if (res.headersSent) res.end(); else if (!res.destroyed) reply(res, status, body); };
  try {
    if (req.method !== 'POST') return fail(405, errorBody('use POST', 'invalid_request_error'));
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return fail(415, errorBody('JSON required', 'invalid_request_error'));
    // The capability may arrive the way each client sends its key: x-api-key (Anthropic SDK) or a Bearer token.
    const token = /^[A-Za-z0-9_-]{43}$/.exec(String(req.headers['x-api-key'] || '').trim())?.[0]
      || /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return fail(401, errorBody('capability required', 'authentication_error'));
    if (!chatGateway) return fail(404, errorBody('not found', 'not_found_error'));
    chatGateway.ledger.authorize(token);
    const policy = chatGateway.ledger.policy();
    const input = await body(req, policy.input_bytes * 6 + 1024);
    if (path === '/v1/messages/count_tokens') {
      // An estimate (a byte count over four), the same kind of bound the ledger reserves with. It is not metered.
      const chat = anthropicToChat({ max_tokens: 1, ...input });
      return reply(res, 200, { input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify([chat.messages, chat.tools || []])) / 4) });
    }
    const chat = anthropicToChat(input);
    const idem = req.headers['idempotency-key'] || randomBytes(16).toString('hex');
    if (chat.stream) {
      const events = streamTranslator(chat.model, (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      await chatGateway.stream(token, idem, chat, chunk => { if (chunk === '[DONE]') events.done(); else events.chunk(chunk); },
        () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }));
      events.done();
      return res.end();
    }
    const result = await chatGateway.call(token, idem, chat);
    if (result.status !== 200) return fail(504, errorBody('the call has not settled yet; its budget stays held', 'api_error'));
    return reply(res, 200, chatToAnthropic(result.body, chat.model));
  } catch (error) { const { status, body: failure } = errorFor(error); fail(status, failure); }
}

// OpenAI Responses API entry point (for Codex). Same idea as handleMessages: translate to the OpenAI-shaped chat request and
// go through ChatGateway, so the call is reserved, dispatched and settled on the same ledger as every other call.
async function handleResponses(req, res, chatGateway) {
  const fail = (status, body) => { if (res.headersSent) res.end(); else if (!res.destroyed) reply(res, status, body); };
  try {
    if (req.method !== 'POST') return fail(405, responsesErrorBody('use POST', 'invalid_request_error'));
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return fail(415, responsesErrorBody('JSON required', 'invalid_request_error'));
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return fail(401, responsesErrorBody('capability required', 'invalid_request_error', 'invalid_api_key'));
    if (!chatGateway) return fail(404, responsesErrorBody('not found', 'invalid_request_error'));
    chatGateway.ledger.authorize(token);
    const policy = chatGateway.ledger.policy();
    const input = await body(req, policy.input_bytes * 6 + 1024);
    const chat = responsesToChat(input);
    const idem = req.headers['idempotency-key'] || randomBytes(16).toString('hex');
    if (chat.stream) {
      const events = responsesStream(chat.model, (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      await chatGateway.stream(token, idem, chat, chunk => { if (chunk === '[DONE]') events.done(); else events.chunk(chunk); },
        () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }));
      events.done();
      return res.end();
    }
    const result = await chatGateway.call(token, idem, chat);
    if (result.status !== 200) return fail(504, responsesErrorBody('the call has not settled yet; its budget stays held', 'server_error'));
    return reply(res, 200, chatToResponse(result.body, chat.model));
  } catch (error) { const { status, body: failure } = responsesErrorFor(error); fail(status, failure); }
}

export function createGatewayServer(gateway, chatGateway = null) {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0];
      if (path === '/v1/messages' || path === '/v1/messages/count_tokens') return await handleMessages(req, res, path, chatGateway);
      if (path === '/v1/responses') return await handleResponses(req, res, chatGateway);
      if (req.method !== 'POST' || !['/v1/generate', '/v1/chat/completions'].includes(req.url)) return reply(res, 404, { error: 'not found' });
      if (req.headers['content-type'] !== 'application/json') return reply(res, 415, { error: 'JSON required' });
      // Bearer capabilities are distinct from person sessions and generic API tokens.
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      if (!match) return reply(res, 401, { error: 'capability required' });
      const handler = req.url === '/v1/chat/completions' ? chatGateway : gateway;
      if (!handler) return reply(res, 404, { error: 'not found' });
      handler.ledger.authorize(match[1]);
      const policy = handler.ledger.policy();
      // JSON escaping can expand each input byte, but is still strictly bounded before parsing.
      const input = await body(req, policy.input_bytes * 6 + 1024);
      // Real agents do not send an Idempotency-Key. Each such request is a new,
      // separately metered call; only a client that supplies a key gets retry
      // de-duplication.
      const idem = req.headers['idempotency-key'] || randomBytes(16).toString('hex');
      if (req.url === '/v1/chat/completions' && input.stream) {
        await handler.stream(match[1], idem, input, chunk => res.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`),
          () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }));
        return res.end();
      }
      const result = await handler.call(match[1], idem, input);
      reply(res, result.status, result.body);
    } catch (error) {
      const status = /cap exceeded/.test(error.message) ? 402
        : /concurrency/.test(error.message) ? 429
          : /capability|stale|stopped/.test(error.message) ? 403
            : /corrupt|verification|accounting/.test(error.message) ? 503 : 400;
      // After the stream has started, the status line is already sent: end it.
      if (res.headersSent) res.end();
      else if (!res.destroyed) reply(res, status, { error: 'gateway refused request' });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}
