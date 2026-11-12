import { createServer } from 'node:http';

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

// This keeps provider credentials outside the ledger and turns the narrow
// completion contract into the legacy gateway response shape. Construct the
// Ledger with the matching provider/config priceRate before exposing this path.
export function providerGateway(ledger, provider, options) {
  return new Gateway(ledger, async input => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ledger.policy().timeout_ms);
    try {
      const result = await provider.complete({ system: options?.system || '',
        messages: [{ role: 'user', content: input.input }], maxOutputTokens: input.max_output_tokens,
        model: input.model, signal: controller.signal });
      return { output: result.text, usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens } };
    } finally { clearTimeout(timeout); }
  });
}

export function createGatewayServer(gateway) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/generate') return reply(res, 404, { error: 'not found' });
      if (req.headers['content-type'] !== 'application/json') return reply(res, 415, { error: 'JSON required' });
      // Bearer capabilities are distinct from person sessions and generic API tokens.
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      if (!match) return reply(res, 401, { error: 'capability required' });
      gateway.ledger.authorize(match[1]);
      const policy = gateway.ledger.policy();
      // JSON escaping can expand each input byte, but is still strictly bounded before parsing.
      const input = await body(req, policy.input_bytes * 6 + 1024);
      const result = await gateway.call(match[1], req.headers['idempotency-key'], input);
      reply(res, result.status, result.body);
    } catch (error) {
      const status = /cap exceeded/.test(error.message) ? 402
        : /concurrency/.test(error.message) ? 429
          : /capability|stale|stopped/.test(error.message) ? 403
            : /corrupt|verification|accounting/.test(error.message) ? 503 : 400;
      if (!res.destroyed) reply(res, status, { error: 'gateway refused request' });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}
