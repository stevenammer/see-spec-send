import { meteringSummary, meteringSummaries } from '../gateway/ledger.js';
import { checkedFromQuest } from '../public/vision-quest.js';
import { preflightQuestModel, draftQuestModel } from '../provider/vision-quest.js';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { isIP } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Integrations } from './integrations.js';
import { feedPage, htmlHeaders, itemPage, newItemPage, passwordPage, questPage, redeemPage, signInPage } from './pages.js';
import { invalid, kindOf, refused, tooLarge as tooLargeError } from '../core/errors.js';
import { redact } from '../provider/safe-http.js';
import { CURRENT_RULES } from '../core/machine.js';
import { buildPacket } from '../core/packet.js';
import { specPage } from './pages-spec.js';

// Object key order does not change a retry identity. Array order is meaningful.
const canonical = value => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

// Fixed defaults. None of these is a setting; a stricter limit needs a code change and a test.
const WRITES_PER_MINUTE = 60;
const EVENT_BYTES = 16 * 1024;
const tooLarge = value => Buffer.byteLength(JSON.stringify(value)) > EVENT_BYTES;
const pageAfter = url => {
  const after = url.searchParams.get('after');
  return typeof after === 'string' && after.length <= 128 ? after : '';
};

// The route pattern for a request, so the log never carries item IDs, artifact hashes or query strings.
const routeOf = raw => {
  let path;
  try { path = new URL(raw, 'http://localhost').pathname; } catch { return '/'; }
  return path
    .replace(/^\/api\/items\/[^/]+\/artifact\/[a-f0-9]{64}$/, '/api/items/:id/artifact/:hash')
    .replace(/^\/api\/items\/[^/]+/, '/api/items/:id')
    .replace(/^\/items\/[^/]+$/, '/items/:id')
    .replace(/^\/api\/integrations\/inbound\/[^/]+$/, '/api/integrations/inbound/:source')
    .slice(0, 120);
};

// A try a model wrote runs no script at all. A hand-delivered try keeps its existing frame.
const MODEL_TRY_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; script-src 'none'";
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
// The address that counts for lockout and limits. A forwarded header is believed only when the socket peer is
// loopback (the one proxy hop on this host), and only its rightmost entry, which the proxy appended itself.
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
export const isLoopback = address => typeof address === 'string' && LOOPBACK.test(address);
export function clientAddress(req, trustedProxy = false) {
  const peer = req.socket?.remoteAddress || 'local';
  if (!trustedProxy || !isLoopback(peer)) return peer;
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded !== 'string') return peer;
  const rightmost = forwarded.split(',').at(-1).trim();
  return isIP(rightmost) ? rightmost : peer;
}

const headers = (res, secure = false) => {
  // Browsers only honor HSTS over HTTPS, so it goes out exactly when the cookies are Secure.
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
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
      if (size > limit && !refused) { refused = true; reject(tooLargeError('body too large')); }
      else if (!refused) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => { if (!refused) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
const body = async (req, limit) => {
  const raw = await bytes(req, limit).catch(error => {
    if (kindOf(error) === 'too_large') throw error;
    throw invalid('bad json');
  });
  try { const value = JSON.parse(raw.toString('utf8') || '{}');
    if (!safeObject(value)) throw invalid('bad json'); return value;
  } catch { throw invalid('bad json'); }
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
  if (!looked.length) throw refused('check required');
  return { problem: input.problem, looked, found: [], verdict: input.verdict };
};
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const stringList = (value, limit = 100) => Array.isArray(value) && value.length <= limit && value.every(line => text(line, 2000));
const exactKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const validEvent = input => {
  if (!input || typeof input !== 'object') return false;
  switch (input.type) {
    case 'checked': return exactKeys(input, ['type', 'problem', 'looked', 'found', 'verdict', 'evidence'])
      && text(input.problem, 2000) && stringList(input.looked) && input.looked.length > 0
      && stringList(input.found) && ['already_have', 'setting', 'free', 'pay', 'build_needed'].includes(input.verdict)
      && (input.evidence === undefined || Array.isArray(input.evidence));
    case 'specced': return (exactKeys(input, ['type', 'must', 'how_we_know', 'out_of_scope']) ||
        (exactKeys(input, ['type', 'see_hash', 'must', 'how_we_know', 'out_of_scope', 'assumptions', 'open_questions'])
          && hex(input.see_hash) && (input.assumptions === undefined || stringList(input.assumptions))
          && (input.open_questions === undefined || stringList(input.open_questions))))
      && stringList(input.must) && stringList(input.how_we_know) && input.how_we_know.length > 0 && stringList(input.out_of_scope);
    case 'approved': return (exactKeys(input, ['type', 'cap_usd', 'quorum'])
        || (exactKeys(input, ['type', 'spec_hash', 'expected_seq', 'cap_usd', 'quorum'])
          && hex(input.spec_hash) && Number.isSafeInteger(input.expected_seq) && input.expected_seq >= 0)
        || (exactKeys(input, ['type', 'spec_hash', 'packet_hash', 'reason', 'cap_usd', 'quorum'])
          && hex(input.spec_hash) && hex(input.packet_hash) && text(input.reason, 2000)))
      && typeof input.cap_usd === 'number' && Number.isInteger(input.quorum) && input.quorum >= 1;
    case 'returned': case 'shelved': case 'checked_in':
      return exactKeys(input, ['type', input.type === 'shelved' ? 'reason' : 'note']) && text(input[input.type === 'shelved' ? 'reason' : 'note'], 2000);
    case 'helped': return exactKeys(input, ['type', 'artifact_hash']) && hex(input.artifact_hash);
    case 'steward_changed': return exactKeys(input, ['type', 'steward', 'reason']) && text(input.steward, 64)
      && (input.reason === undefined || text(input.reason, 2000));
    case 'revised': return (exactKeys(input, ['type', 'text', 'base_hash']) ||
        (exactKeys(input, ['type', 'text', 'base_hash', 'credits']) && Array.isArray(input.credits)
          && input.credits.every(credit => credit && hex(credit.comment) && ['quoted', 'paraphrased'].includes(credit.mode))))
      && text(input.text, 4000) && hex(input.base_hash);
    case 'commented': return exactKeys(input, ['type', 'comment', 'anchor_kind', 'anchor_hash', 'parent', 'kind'])
      && text(input.comment, 4000) && ((input.anchor_kind === undefined && input.anchor_hash === undefined)
        || (['see', 'spec', 'artifact'].includes(input.anchor_kind) && hex(input.anchor_hash)))
      && (input.parent === undefined || hex(input.parent))
      && (input.kind === undefined || ['comment', 'question', 'concern'].includes(input.kind));
    case 'sent': case 'forked': case 'steered': return false;
    default: return false;
  }
};

export function createHandler({ auth, store, integrations, questModel = null, secure = true, origin = 'https://localhost', clock = Date.now, log = () => {}, trustedProxy = false }) {
  integrations ||= new Integrations(store, { origin });
  // Fixed one-minute windows per signed-in member. Memory holds one entry per member.
  const writes = new Map();
  const spend = (person, now) => {
    const window = writes.get(person);
    if (!window || now - window.start >= 60_000) { writes.set(person, { start: now, count: 1 }); return true; }
    window.count += 1;
    return window.count <= WRITES_PER_MINUTE;
  };
  const sameOrigin = sameOriginAs(origin);
  // Quest input that fails the shared validator is an invalid request, whatever the validator's wording.
  const fromQuest = (quest, person) => {
    try { return checkedFromQuest(quest, person); } catch (error) { throw invalid(error.message); }
  };
  const cookieName = secure ? '__Host-sss' : 'sss';
  const cookie = value =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const oidcBinderName = secure ? '__Host-sss-oidc' : 'sss-oidc';
  const oidcBinderCookie = value =>
    `${oidcBinderName}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  // One line per sign-in or step-up outcome. Passwords, cookies and tokens never reach a log line.
  const emit = entry => log(JSON.stringify(entry));
  const outcome = async (context, event, attempt, { person = null, account = null } = {}) => {
    try {
      const result = await attempt();
      emit({ event, rid: context.rid, outcome: 'ok', person });
      return result;
    } catch (error) {
      emit({ event, rid: context.rid, outcome: 'refused', account });
      throw error;
    }
  };
  const accountOf = value => (typeof value === 'string' ? value.slice(0, 64) : null);
  const serve = async (req, res, context) => {
    headers(res, secure);
    try {
      const url = new URL(req.url, origin);
      const change = req.method === 'POST';
      const inbound = url.pathname.match(/^\/api\/integrations\/inbound\/([A-Za-z0-9._-]{1,64})$/);
      if (req.method === 'POST' && inbound) {
        if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'request refused' });
        // Inbound intake keeps its own answer for an oversized body (400), so the generic 413 mapping does not reach it.
        const raw = await bytes(req, 16 * 1024).catch(() => { throw invalid('inbound body over limit'); });
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
      if (session) context.person = session.person;
      if (change && req.headers['content-type'] !== 'application/json')
        return json(res, 415, { error: 'request refused' });
      if (
        change &&
        !['/api/login', '/api/invite/redeem'].includes(url.pathname) &&
        (!sameOrigin(req.headers.origin || req.headers.referer) ||
          req.headers['x-csrf-token'] !== session?.csrf)
      )
        return json(res, 403, { error: 'request refused' });
      let input = change ? await body(req) : {};
      const ip = clientAddress(req, trustedProxy);
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
          emit({ event: 'sign_in', rid: context.rid, method: 'oidc', outcome: 'refused' });
          res.setHeader('set-cookie', clearBinder);
          return json(res, 400, { error: 'request refused' });
        }
        emit({ event: 'sign_in', rid: context.rid, method: 'oidc', outcome: 'ok', person: auth.session(login.value)?.person ?? null });
        res.setHeader('set-cookie', [cookie(login.value), clearBinder]);
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const login = await outcome(context, 'sign_in', () => auth.login(input.id, input.password, ip),
          { person: accountOf(input.id), account: accountOf(input.id) });
        res.setHeader('set-cookie', cookie(login.value));
        return json(res, 200, { csrf: login.csrf });
      }
      if (req.method === 'POST' && url.pathname === '/api/invite/redeem') {
        const login = await outcome(context, 'invite_redeem', () => auth.redeem(input.invite, input.id, input.password, ip),
          { person: accountOf(input.id), account: accountOf(input.id) });
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
      if (change && !spend(session.person, clock()))
        return json(res, 429, { error: 'slow down, try again in a minute' });
      if (req.method === 'POST' && url.pathname === '/api/stepup') {
        await outcome(context, 'step_up', () => auth.stepup(sessionToken, input.password, ip),
          { person: session.person, account: session.person });
        return json(res, 204, {});
      }
      if (req.method === 'POST' && url.pathname === '/api/password') {
        const next = await auth.changePassword(sessionToken, input.password);
        res.setHeader('set-cookie', cookie(next.value));
        return json(res, 200, { csrf: next.csrf });
      }
      if (req.method === 'GET' && url.pathname === '/password') return page(res, passwordPage());
      // A temporary password (init or a reset code) can reach only the routes above until it is replaced.
      if (session.must_change === 1) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) { res.writeHead(302, { location: '/password', 'cache-control': 'no-store' }); return res.end(); }
        return json(res, 403, { error: 'request refused' });
      }
      let leader = false;
      try { leader = store.actor(session.person, '').leader === true; } catch { /* unregistered session holder is not a leader */ }
      if (req.method === 'GET' && url.pathname === '/') {
        const listing = store.listPage(pageAfter(url));
        return page(res, feedPage(listing.items, listing.next));
      }
      if (req.method === 'GET' && url.pathname === '/items/new') return page(res, newItemPage());
      if (req.method === 'GET' && url.pathname === '/quest') {
        return page(res, questPage(session.person));
      }
      const specView = url.pathname.match(/^\/items\/([^/]+)\/spec$/);
      if (req.method === 'GET' && specView) {
        const state = store.read(specView[1]);
        return page(res, specPage({ id: specView[1], ...state }, store.events(specView[1]), session.person));
      }
      const view = url.pathname.match(/^\/items\/([^/]+)$/);
      if (req.method === 'GET' && view) {
        const state = store.read(view[1]);
        const events = store.events(view[1]);
        if (state.state === 'SPECCED' && leader && state.context.steward !== session.person)
          auth.reviewApproval(sessionToken, view[1], state.context.specHash, events.length);
        return page(
          res,
          itemPage({ id: view[1], ...state, packet: state.context.sent && store.artifact(view[1], state.context.sent.packetHash),
            effort: store.db.prepare('SELECT kind,state,last_error FROM effort_jobs WHERE item=? ORDER BY created').all(view[1]) }, events, session.person, leader),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/items') {
        const listing = store.listPage(pageAfter(url));
        // One receipt verification pass covers the whole page.
        const budgets = meteringSummaries(store, listing.items.map(item => item.id));
        return json(res, 200, { items: listing.items.map(item => ({ ...item,
          spent_basis: 'legacy charged events only', gateway_budget: budgets.get(item.id) })), next: listing.next });
      }
      if (req.method === 'POST' && url.pathname === '/api/items') {
        if (!input.quest && tooLarge(input)) return json(res, 413, { error: 'request too large' });
        if (Object.hasOwn(input, 'original')) {
          if (!exactKeys(input, ['original']) || !text(input.original, 4000))
            return json(res, 409, { error: 'request refused' });
          const idem = req.headers['idempotency-key'] || randomUUID();
          // A retry must point at the same fresh item, so idempotency can run before
          // Store's fresh-item guard. Random IDs turn a double click into two SEEs.
          const id = createHash('sha256').update(`posted\0${session.person}\0${idem}`).digest('base64url');
          const prior = store.events(id).find(event => event.type === 'posted' && event.actor === session.person);
          const retry = prior?.original === input.original && { type: prior.type, actor: prior.actor,
            original: prior.original, rules: prior.rules, at: prior.at };
          store.append(id, retry || { type: 'posted', actor: session.person, original: input.original,
            rules: CURRENT_RULES, at: new Date().toISOString() }, { idem });
          return json(res, 201, { id, state: store.read(id) });
        }
        // Derive and validate before looking up a receipt, including the signed-in owner.
        const eventBody = input.quest ? fromQuest(input.quest, session.person) : checked(input);
        const id = input.quest ? createHash('sha256').update(canonical({
          person: session.person, quest: input.quest,
        })).digest('hex') : randomBytes(24).toString('base64url');
        // This entire lookup/append block is synchronous. Concurrent requests cannot
        // interleave it; the deterministic item ID also survives server restarts.
        const prior = input.quest ? store.events(id) : [];
        if (prior.length) {
          if (prior[0].type !== 'checked' || prior[0].actor !== session.person) {
            throw invalid('Quest receipt owner does not match.');
          }
          return json(res, 200, { id, state: store.read(id), idempotent: true });
        }
        store.append(id, { type: 'checked', actor: session.person,
          at: new Date().toISOString(), ...eventBody },
        { idem: input.quest ? `quest:${id}` : randomUUID() });
        return json(res, 201, { id, state: store.read(id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/quest/model/preflight') {
        if (!questModel) return json(res, 404, { error: 'not found' });
        if (typeof questModel.preflight !== 'function') return json(res, 404, { error: 'not found' });
        return json(res, 200, await questModel.preflight(input, session.person));
      }
      if (req.method === 'POST' && url.pathname === '/api/quest/model/draft') {
        if (!questModel) return json(res, 404, { error: 'not found' });
        if (typeof questModel.draft !== 'function') return json(res, 404, { error: 'not found' });
        return json(res, 200, await questModel.draft(session.person, input, req.headers['idempotency-key'] || randomUUID()));
      }
      const send = url.pathname.match(/^\/api\/items\/([^/]+)\/send$/);
      if (req.method === 'POST' && send) {
        if (!exactKeys(input, ['spec_hash']) || !hex(input.spec_hash)) return json(res, 409, { error: 'request refused' });
        const events = store.events(send[1]); const first = events[0];
        const spec = events.find(event => event.type === 'specced' && event.body_hash === input.spec_hash);
        const see = events.filter(event => event.type === 'revised').at(-1)?.text || first?.original;
        if (!first || !spec) throw refused('current spec required');
        const packet = buildPacket({ original: first.original, see, spec: { ...spec, hash: input.spec_hash }, credits: [],
          comments: events.filter(event => event.type === 'commented'), gatewayPolicy: {}, sandboxLimits: {} });
        const packet_hash = store.putArtifact(send[1], JSON.stringify(packet));
        const result = store.append(send[1], { type: 'sent', actor: session.person, spec_hash: input.spec_hash, packet_hash,
          at: new Date().toISOString() }, { idem: req.headers['idempotency-key'] || randomUUID() });
        return json(res, 201, { ...result, packet_hash });
      }
      const fork = url.pathname.match(/^\/api\/items\/([^/]+)\/fork$/);
      if (req.method === 'POST' && fork) {
        if (!exactKeys(input, ['reason']) || !text(input.reason, 2000)) return json(res, 409, { error: 'request refused' });
        const events = store.events(fork[1]); const parent = store.eventRows(fork[1]).at(-1); const first = events[0];
        const current = events.filter(event => event.type === 'revised').at(-1)?.text || first?.original;
        if (!parent || !first) throw refused('parent required');
        const id = randomUUID();
        const result = store.append(id, { type: 'forked', actor: session.person, original: current, rules: CURRENT_RULES,
          parent: { item: fork[1], seq: parent.seq, hash: parent.hash }, at: new Date().toISOString() },
        { idem: req.headers['idempotency-key'] || `fork:${fork[1]}:${parent.hash}:${session.person}` });
        return json(res, 201, { id, ...result });
      }
      const steer = url.pathname.match(/^\/api\/items\/([^/]+)\/steer$/);
      if (req.method === 'POST' && steer) {
        if (!exactKeys(input, ['instruction', 'source', 'mode']) || !text(input.instruction, 4000)
          || (input.source !== undefined && !hex(input.source))
          || (input.mode !== undefined && !['quoted', 'paraphrased'].includes(input.mode))) return json(res, 409, { error: 'request refused' });
        const context = store.read(steer[1]).context;
        const result = store.append(steer[1], { type: 'steered', actor: session.person, instruction: input.instruction,
          ...(input.source ? { source: input.source, mode: input.mode || 'paraphrased' } : {}), approval: context.approval,
          spec_hash: context.specHash, at: new Date().toISOString() }, { idem: req.headers['idempotency-key'] || randomUUID() });
        return json(res, 201, result);
      }
      const artifact = url.pathname.match(/^\/api\/items\/([^/]+)\/artifact\/([a-f0-9]{64})$/);
      if (req.method === 'GET' && artifact) {
        // A try is shown only inside the item page's sandboxed frame. Opened as a page, it would run on this hostname.
        if (req.headers['sec-fetch-dest'] !== 'iframe') return json(res, 403, { error: 'request refused' });
        const html = store.artifact(artifact[1], artifact[2]);
        if (html === null) return json(res, 404, { error: 'not found' });
        const modelOutput = store.events(artifact[1]).some(event =>
          event.type === 'tried' && event.artifact_hash === artifact[2] && event.model_output === true);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': modelOutput ? MODEL_TRY_CSP :
            "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        });
        return res.end(html);
      }
      const deliver = url.pathname.match(/^\/api\/items\/([^/]+)\/artifact$/);
      if (req.method === 'POST' && deliver) {
        const state = store.read(deliver[1]);
        if (!(leader || state.context.steward === session.person))
          throw refused('event not allowed');
        // Check the stage before storing any bytes, so a refused delivery leaves nothing behind.
        if (state.state !== 'SENDING') throw refused('event not allowed');
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
            iteration: state.context.iteration,
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
      if (tooLarge(input)) return json(res, 413, { error: 'request too large' });
      if (store.eventCapReached(match[1], input.type)) return json(res, 429, { error: 'item is full' });
      if (Object.hasOwn(input, 'quest')) return json(res, 409, { error: 'request refused' });
      if (Object.hasOwn(input, 'questMemo')) return json(res, 409, { error: 'request refused' });
      if (Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'role'))
        return json(res, 403, { error: 'request refused' });
      if (input.type === 'approved' && !auth.hasStepup(sessionToken))
        return json(res, 403, { error: 'request refused' });
      if (!validEvent(input)) return json(res, 409, { error: 'request refused' });
      if (input.type === 'approved' && input.spec_hash === undefined) {
        // Older API clients did not carry the rendered binding. Bind them to the
        // current record here; a browser that has seen Decide must echo its view.
        if (auth.approvalReview(sessionToken, match[1]))
          return json(res, 409, { error: 'request refused' });
        const state = store.read(match[1]);
        input = { ...input, spec_hash: state.context.specHash, expected_seq: store.eventRows(match[1]).length };
      }
      if (input.type === 'commented') {
        const state = store.read(match[1]).context;
        const current = { see: state.seeHash,
          spec: state.specSeeHash === state.seeHash ? state.specHash : null, artifact: state.artifact };
        if (current[input.anchor_kind] !== input.anchor_hash) {
          return json(res, 409, { error: 'request refused' });
        }
      }
      if (input.type === 'approved') {
        if (!auth.useStepup(sessionToken)) return json(res, 403, { error: 'request refused' });
      }
      return json(
        res,
        201,
        store.append(
          match[1],
          { ...input, actor: session.person, at: new Date().toISOString() },
          { expectedSeq: input.expected_seq, idem: req.headers['idempotency-key'] || randomUUID() },
        ),
      );
    } catch (error) {
      // Each status comes from the error's kind, never from its message.
      const kind = kindOf(error);
      if (kind === 'busy') {
        res.setHeader('retry-after', '1');
        return json(res, 503, { error: 'busy, try again in a moment' });
      }
      if (kind === 'too_large') return json(res, 413, { error: 'request too large' });
      if (kind === 'refused') return json(res, 409, { error: 'request refused' });
      if (kind === 'invalid') return json(res, 400, { error: 'request refused' });
      // A plain error is a defect. The client gets the request ID to quote; the stack goes to the log.
      emit({ event: 'error', rid: context.rid, route: routeOf(req.url), status: 500, stack: redact(String(error?.stack || error)) });
      return json(res, 500, { error: 'server error', request_id: context.rid });
    }
  };
  return async (req, res) => {
    const context = { rid: randomUUID(), person: null };
    const started = performance.now();
    res.setHeader('x-request-id', context.rid);
    try {
      await serve(req, res, context);
    } finally {
      emit({ event: 'request', rid: context.rid, route: routeOf(req.url), status: res.statusCode ?? res.status,
        person: context.person, ms: Math.round(performance.now() - started) });
    }
  };
}
export function createServerFor({ tls = null, ...deps }) {
  // The product server writes its request and sign-in lines to stderr. Tests pass their own sink.
  const handler = createHandler({ log: line => process.stderr.write(`${line}\n`), ...deps });
  // Direct HTTPS uses the certificate pair from serveSettings. Without it the listener is plain HTTP.
  const server = tls ? createTlsServer({ cert: tls.cert, key: tls.key }, handler) : createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
