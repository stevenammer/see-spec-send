import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const headers = res => {
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
};
const body = req => new Promise((resolve, reject) => {
  let size = 0;
  let text = '';
  req.on('data', chunk => {
    size += chunk.length;
    if (size > 16_384) reject(new Error('body too large'));
    else text += chunk;
  });
  req.on('end', () => {
    try {
      const value = JSON.parse(text || '{}');
      if (!value || Array.isArray(value) || Object.keys(value).some(key =>
        ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('bad json');
      resolve(value);
    } catch { reject(new Error('bad json')); }
  });
  req.on('error', reject);
});
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
  const [key, ...rest] = part.trim().split('=');
  return [key, rest.join('=')];
}).filter(([key]) => key));

// Compare parsed origins; a prefix match would accept lookalike hosts such as localhost.evil.test.
const sameOriginAs = expected => value => {
  try { return new URL(value).origin === new URL(expected).origin; } catch { return false; }
};

export function createHandler({ auth, store, secure = true, origin = 'https://localhost' }) {
  const sameOrigin = sameOriginAs(origin);
  const cookieName = secure ? '__Host-sss' : 'sss';
  const cookie = value => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return async (req, res) => {
    headers(res);
    try {
      const url = new URL(req.url, origin);
      const change = req.method === 'POST';
      const sessionToken = cookies(req)[cookieName];
      const session = sessionToken && auth.session(sessionToken);
      if (change && req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'request refused' });
      if (change && url.pathname !== '/api/login' && url.pathname !== '/api/invite/redeem') {
        // Browser state changes require both a same-origin request and session-bound nonce.
        if (!sameOrigin(req.headers.origin || req.headers.referer)
            || req.headers['x-csrf-token'] !== session?.csrf) {
          return json(res, 403, { error: 'request refused' });
        }
      }
      const input = change ? await body(req) : {};
      const ip = req.socket?.remoteAddress || 'local';
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const login = await auth.login(input.id, input.password, ip);
        res.setHeader('set-cookie', cookie(login.value));
        return json(res, 200, { csrf: login.csrf });
      }
      if (req.method === 'POST' && url.pathname === '/api/invite/redeem') {
        const login = await auth.redeem(input.invite, input.id, input.password, ip);
        res.setHeader('set-cookie', cookie(login.value));
        return json(res, 201, { csrf: login.csrf });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        auth.revoke(sessionToken);
        res.setHeader('set-cookie', cookie('') + '; Max-Age=0');
        return json(res, 204, {});
      }
      if (req.method === 'GET' && url.pathname === '/api/me') {
        return session ? json(res, 200, { id: session.person, csrf: session.csrf }) : json(res, 403, { error: 'request refused' });
      }
      if (!session) return json(res, 403, { error: 'request refused' });
      if (req.method === 'POST' && url.pathname === '/api/stepup') {
        await auth.stepup(sessionToken, input.password, ip);
        return json(res, 204, {});
      }
      const match = url.pathname.match(/^\/api\/items\/([^/]+)(?:\/events)?$/);
      if (!match) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') return json(res, 200, { state: store.read(match[1]), events: store.events(match[1]) });
      if (Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'role')) return json(res, 403, { error: 'request refused' });
      if (input.type === 'approved' && !auth.useStepup(sessionToken)) return json(res, 403, { error: 'request refused' });
      const event = { ...input, actor: session.person, at: new Date().toISOString() };
      return json(res, 201, store.append(match[1], event, { idem: req.headers['idempotency-key'] || randomUUID() }));
    } catch (error) {
      return json(res, /refused|not allowed|stale|approval|event/.test(error.message) ? 409 : 400,
        { error: 'request refused' });
    }
  };
}

export function createServerFor(deps) {
  const server = createServer(createHandler(deps));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
