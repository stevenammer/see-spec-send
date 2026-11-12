import { meteringSummary } from '../gateway/ledger.js';
import { checkedFromQuest } from '../public/vision-quest.js';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Integrations } from './integrations.js';
import { feedPage, htmlHeaders, itemPage, newItemPage, questPage, redeemPage, signInPage } from './pages.js';

// Object key order does not change a retry identity. Array order is meaningful.
const canonical = value => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
const headers = res => {
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
};
const page = (res, html) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': htmlHeaders,
  });
  res.end(html);
};
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const safeObject = value =>
  value === null ||
  typeof value !== 'object' ||
  (Array.isArray(value)
    ? value.every(safeObject)
    : Object.keys(value).every(key => !unsafe.has(key) && safeObject(value[key])));
const bytes = (req, limit = 300 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let refused = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit && !refused) { refused = true; reject(new Error('body too large')); }
      else if (!refused) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => { if (!refused) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
const body = async (req, limit) => {
  try { const value = JSON.parse((await bytes(req, limit)).toString('utf8') || '{}');
    if (!safeObject(value)) throw new Error('bad json'); return value;
  } catch { throw new Error('bad json'); }
};
const cookies = req =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map(part => {
        const [key, ...rest] = part.trim().split('=');
        return [key, rest.join('=')];
      })
      .filter(([key]) => key),
  );
const sameOriginAs = expected => value => {
  try {
    return new URL(value).origin === new URL(expected).origin;
  } catch {
    return false;
  }
};
const staticFile = (res, file, type) => {
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(readFileSync(join(new URL('..', import.meta.url).pathname, 'public', file)));
};
const checked = input => {
  const looked = ['have', 'pay_for', 'free', 'setting']
    .filter(key => input[key])
    .map(key => `${key}:${String(input[`${key}_note`] || '').slice(0, 280)}`);
  if (!looked.length) throw new Error('check required');
  return { problem: input.problem, looked, found: [], verdict: input.verdict };
};

export function createHandler({ auth, store, integrations, secure = true, origin = 'https://localhost' }) {
  integrations ||= new Integrations(store, { origin });
  const sameOrigin = sameOriginAs(origin);
  const cookieName = secure ? '__Host-sss' : 'sss';
  const cookie = value =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const oidcBinderName = secure ? '__Host-sss-oidc' : 'sss-oidc';
  const oidcBinderCookie = value =>
    `${oidcBinderName}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return async (req, res) => {
    headers(res);
    try {
      const url = new URL(req.url, origin);
      const change = req.method === 'POST';
      const inbound = url.pathname.match(/^\/api\/integrations\/inbound\/([A-Za-z0-9._-]{1,64})$/);
      if (req.method === 'POST' && inbound) {
        if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'request refused' });
        const raw = await bytes(req, 16 * 1024);
        return json(res, 201, integrations.receive(inbound[1], req.headers['x-sss-timestamp'], req.headers['x-sss-signature'], raw, req.headers));
      }
      if (req.method === 'GET' && url.pathname === '/assets/app.js')
        return staticFile(res, 'app.js', 'application/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/assets/app.css')
        return staticFile(res, 'app.css', 'text/css; charset=utf-8');
      if (req.method === 'GET' &&
          ['/assets/vision-quest.js', '/assets/quest-storage.js', '/assets/quest-ui.js']
            .includes(url.pathname)) {
        return staticFile(res, url.pathname.split('/').at(-1),
          'application/javascript; charset=utf-8');
      }
      const sessionToken = cookies(req)[cookieName];
      const session = sessionToken && auth.session(sessionToken);
      if (change && req.headers['content-type'] !== 'application/json')
        return json(res, 415, { error: 'request refused' });
      if (
        change &&
        !['/api/login', '/api/invite/redeem'].includes(url.pathname) &&
        (!sameOrigin(req.headers.origin || req.headers.referer) ||
          req.headers['x-csrf-token'] !== session?.csrf)
      )
        return json(res, 403, { error: 'request refused' });
      const input = change ? await body(req) : {};
      const ip = req.socket?.remoteAddress || 'local';
      if (req.method === 'GET' && url.pathname === '/api/oidc/start') {
        if (!auth.oidc) return json(res, 404, { error: 'not found' });
        const binder = randomBytes(32).toString('base64url');
        res.setHeader('set-cookie', oidcBinderCookie(binder));
        res.writeHead(302, { location: auth.beginOidc(binder), 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/oidc/callback') {
        if (!auth.oidc) return json(res, 404, { error: 'not found' });
        let login;
        // Clear the one-time browser binding on every callback outcome.  The
        // state is consumed by OidcLogin before a failed exchange or mismatch.
        const clearBinder = oidcBinderCookie('') + '; Max-Age=0';
        try {
          login = await auth.completeOidc({ state: url.searchParams.get('state'),
            code: url.searchParams.get('code'), binder: cookies(req)[oidcBinderName] });
        } catch {
          res.setHeader('set-cookie', clearBinder);
          return json(res, 400, { error: 'request refused' });
        }
        res.setHeader('set-cookie', [cookie(login.value), clearBinder]);
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        return res.end();
      }
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
      if (req.method === 'GET' && url.pathname === '/signin') return page(res, signInPage({ oidc: Boolean(auth.oidc) }));
      if (req.method === 'GET' && url.pathname === '/redeem') return page(res, redeemPage());
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        auth.revoke(sessionToken);
        res.setHeader('set-cookie', cookie('') + '; Max-Age=0');
        return json(res, 204, {});
      }
      if (req.method === 'GET' && url.pathname === '/api/me')
        return session
          ? json(res, 200, { id: session.person, csrf: session.csrf })
          : json(res, 403, { error: 'request refused' });
      if (!session) {
        if (req.method === 'GET' && url.pathname === '/') return page(res, signInPage({ oidc: Boolean(auth.oidc) }));
        return json(res, 403, { error: 'request refused' });
      }
      if (req.method === 'POST' && url.pathname === '/api/stepup') {
        await auth.stepup(sessionToken, input.password, ip);
        return json(res, 204, {});
      }
      let leader = false;
      try { leader = store.actor(session.person, '').leader === true; } catch { /* unregistered session holder is not a leader */ }
      if (req.method === 'GET' && url.pathname === '/')
        return page(res, feedPage(store.listItems()));
      if (req.method === 'GET' && url.pathname === '/items/new') return page(res, newItemPage());
      if (req.method === 'GET' && url.pathname === '/quest') {
        return page(res, questPage(session.person));
      }
      const view = url.pathname.match(/^\/items\/([^/]+)$/);
      if (req.method === 'GET' && view) {
        const state = store.read(view[1]);
        return page(
          res,
          itemPage({ id: view[1], ...state }, store.events(view[1]), session.person, leader),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/items')
        return json(res, 200, { items: store.listItems().map(item => ({ ...item,
          spent_basis: 'legacy charged events only', gateway_budget: meteringSummary(store, item.id) })) });
      if (req.method === 'POST' && url.pathname === '/api/items') {
        // Derive and validate before looking up a receipt, including the signed-in owner.
        const eventBody = input.quest ? checkedFromQuest(input.quest, session.person) : checked(input);
        const id = input.quest ? createHash('sha256').update(canonical({
          person: session.person, quest: input.quest,
        })).digest('hex') : randomBytes(24).toString('base64url');
        // This entire lookup/append block is synchronous. Concurrent requests cannot
        // interleave it; the deterministic item ID also survives server restarts.
        const prior = input.quest ? store.events(id) : [];
        if (prior.length) {
          if (prior[0].type !== 'checked' || prior[0].actor !== session.person) {
            throw Error('Quest receipt owner does not match.');
          }
          return json(res, 200, { id, state: store.read(id), idempotent: true });
        }
        store.append(id, { type: 'checked', actor: session.person,
          at: new Date().toISOString(), ...eventBody },
        { idem: input.quest ? `quest:${id}` : randomUUID() });
        return json(res, 201, { id, state: store.read(id) });
      }
      const artifact = url.pathname.match(/^\/api\/items\/([^/]+)\/artifact\/([a-f0-9]{64})$/);
      if (req.method === 'GET' && artifact) {
        const html = store.artifact(artifact[1], artifact[2]);
        if (html === null) return json(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        });
        return res.end(html);
      }
      const deliver = url.pathname.match(/^\/api\/items\/([^/]+)\/artifact$/);
      if (req.method === 'POST' && deliver) {
        const state = store.read(deliver[1]);
        if (!(leader || state.context.steward === session.person))
          throw new Error('event not allowed');
        // Check the stage before storing any bytes, so a refused delivery leaves nothing behind.
        if (state.state !== 'SENDING') throw new Error('event not allowed');
        const hash = store.putArtifact(deliver[1], input.html);
        const run = auth.createToken('run', deliver[1]);
        const actor = createHash('sha256').update(run).digest('hex');
        store.append(
          deliver[1],
          {
            type: 'tried',
            actor,
            artifact_hash: hash,
            approval: state.context.approval,
            spec_hash: state.context.specHash,
            delivered_by: session.person,
            at: new Date().toISOString(),
          },
          { idem: randomUUID() },
        );
        return json(res, 201, { hash });
      }
      const match = url.pathname.match(/^\/api\/items\/([^/]+)(?:\/events)?$/);
      if (!match) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET')
        return json(res, 200, { state: store.read(match[1]), events: store.events(match[1]),
          spent_basis: 'state.context.spentMicros counts legacy charged events only',
          gateway_budget: meteringSummary(store, match[1]) });
      if (Object.hasOwn(input, 'quest')) return json(res, 409, { error: 'request refused' });
      if (Object.hasOwn(input, 'questMemo')) return json(res, 409, { error: 'request refused' });
      if (Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'role'))
        return json(res, 403, { error: 'request refused' });
      if (input.type === 'commented') {
        const state = store.read(match[1]).context;
        if ((state.specHash || state.artifact) &&
            !((input.anchor_kind === 'spec' && input.anchor_hash === state.specHash) ||
              (input.anchor_kind === 'artifact' && input.anchor_hash === state.artifact))) {
          return json(res, 409, { error: 'request refused' });
        }
      }
      if (input.type === 'approved') {
        if (!auth.useStepup(sessionToken)) return json(res, 403, { error: 'request refused' });
        input.spec_hash = store.read(match[1]).context.specHash;
      }
      return json(
        res,
        201,
        store.append(
          match[1],
          { ...input, actor: session.person, at: new Date().toISOString() },
          { idem: req.headers['idempotency-key'] || randomUUID() },
        ),
      );
    } catch (error) {
      return json(
        res,
        /refused|not allowed|stale|approval|event|artifact|check/.test(error.message) ? 409 : 400,
        { error: 'request refused' },
      );
    }
  };
}
export function createServerFor(deps) {
  const server = createServer(createHandler(deps));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
