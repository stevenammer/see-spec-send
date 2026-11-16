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
import { feedPage, frozenPostPage, htmlHeaders, itemPage, newItemPage, passwordPage, questPage, redeemPage, signInPage } from './pages.js';
import { invalid, kindOf, refused, tooLarge as tooLargeError } from '../core/errors.js';
import { redact } from '../provider/safe-http.js';
import { CURRENT_RULES, validDateOnly } from '../core/machine.js';
import { buildPacket } from '../core/packet.js';
import { specPage } from './pages-spec.js';
import { researchRecord } from '../research/connectors.js';
import { workspaceConnectors } from '../research/workspace.js';
import { requestSpecDraft } from '../effort/spec.js';
import { evidencePackage, readAnalysisAnswer } from '../intelligence/evidence.js';
import { intelligencePage } from './pages-intelligence.js';
import { effortAllowance } from '../gateway/effort.js';
import { Mentoring } from '../core/mentoring.js';
import { mentoringHome, mentoringRequest, mentoringEvidence } from './pages-mentoring.js';
import { emptyScope, validScope } from '../core/scope.js';
import { reconciliation, forkEligibility, stewardInactivity, transferEligibility } from '../core/reconcile.js';
import { searchPage, contributionsPage, recordPage } from './pages-memory.js';
import { canRead, defaultCanRead } from '../access/read.js';

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
const decisionMetadataValid = (disposition, metadata) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const fields = {
    return_for_revision: ['needed', 'next_reviewer'], defer: ['owner', 'review_by', 'trigger', 'interim_work'],
    redirect: ['destination', 'accepted', 'follow_up_owner'], resolve_without_build: ['alternative', 'action_owner'],
    decline: ['reconsider_if'], prohibited: ['policy_class'],
  }[disposition];
  if (!fields || !exactKeys(metadata, fields)) return false;
  const has = key => text(metadata[key], 2000);
  if (disposition === 'return_for_revision') return has('needed') && has('next_reviewer');
  if (disposition === 'defer') return has('owner') && (has('review_by') || has('trigger'))
    && (!metadata.review_by || validDateOnly(metadata.review_by))
    && (metadata.interim_work === undefined || has('interim_work'));
  if (disposition === 'redirect') return has('destination') && has('follow_up_owner')
    && typeof metadata.accepted === 'boolean';
  if (disposition === 'resolve_without_build') return has('alternative') && has('action_owner');
  if (disposition === 'decline') return metadata.reconsider_if === undefined || has('reconsider_if');
  return has('policy_class');
};
const validEvent = input => {
  if (!input || typeof input !== 'object') return false;
  switch (input.type) {
    case 'checked': return exactKeys(input, ['type', 'problem', 'looked', 'found', 'verdict', 'evidence'])
      && text(input.problem, 2000) && stringList(input.looked) && input.looked.length > 0
      && stringList(input.found) && ['already_have', 'setting', 'free', 'pay', 'build_needed'].includes(input.verdict)
      && (input.evidence === undefined || Array.isArray(input.evidence));
    case 'specced': return (exactKeys(input, ['type', 'must', 'how_we_know', 'out_of_scope']) ||
        (exactKeys(input, ['type', 'see_hash', 'base_spec_hash', 'must', 'how_we_know', 'out_of_scope', 'assumptions', 'open_questions', 'ledger', 'estimates', 'credits', 'scope'])
          && hex(input.see_hash) && (input.assumptions === undefined || stringList(input.assumptions))
          && (input.open_questions === undefined || stringList(input.open_questions))
          && (input.ledger === undefined || Array.isArray(input.ledger))
          && (input.estimates === undefined || Array.isArray(input.estimates))
          && (input.base_spec_hash === undefined || hex(input.base_spec_hash))
          && (input.credits === undefined || (Array.isArray(input.credits) && input.credits.every(credit => credit && hex(credit.comment) && ['quoted', 'paraphrased'].includes(credit.mode))))))
      && stringList(input.must) && stringList(input.how_we_know) && input.how_we_know.length > 0 && stringList(input.out_of_scope)
      && (input.scope === undefined || validScope(input.scope));
    case 'approved': return (exactKeys(input, ['type', 'cap_usd', 'quorum', 'max_iterations', 'window_minutes'])
        || (exactKeys(input, ['type', 'spec_hash', 'expected_seq', 'cap_usd', 'quorum'])
          && hex(input.spec_hash) && Number.isSafeInteger(input.expected_seq) && input.expected_seq >= 0)
        || (exactKeys(input, ['type', 'spec_hash', 'packet_hash', 'reason', 'cap_usd', 'quorum'])
          && hex(input.spec_hash) && hex(input.packet_hash) && text(input.reason, 2000))
        || (exactKeys(input, ['type', 'spec_hash', 'packet_hash', 'reason', 'cap_usd', 'quorum', 'max_iterations', 'window_minutes'])
          && hex(input.spec_hash) && hex(input.packet_hash) && text(input.reason, 2000)))
      && typeof input.cap_usd === 'number' && Number.isInteger(input.quorum) && input.quorum >= 1
      && (input.max_iterations === undefined || (Number.isInteger(input.max_iterations) && input.max_iterations >= 1 && input.max_iterations <= 5))
      && (input.window_minutes === undefined || (Number.isInteger(input.window_minutes) && input.window_minutes >= 1));
    case 'returned': case 'not_built': return exactKeys(input, ['type', 'reason', 'restricted_evidence', 'pivot_note', 'spec_hash', 'packet_hash'])
      && text(input.reason, 2000) && (input.restricted_evidence === undefined || text(input.restricted_evidence, 2000))
      && (input.pivot_note === undefined || text(input.pivot_note, 2000))
      && (input.spec_hash === undefined || hex(input.spec_hash)) && (input.packet_hash === undefined || hex(input.packet_hash));
    case 'decided': return exactKeys(input, ['type', 'disposition', 'reason_code', 'reason', 'metadata', 'spec_hash', 'packet_hash'])
      && ['return_for_revision', 'defer', 'redirect', 'resolve_without_build', 'decline', 'prohibited'].includes(input.disposition)
      && text(input.reason_code, 120) && text(input.reason, 2000) && hex(input.spec_hash) && hex(input.packet_hash)
      && decisionMetadataValid(input.disposition, input.metadata);
    case 'experiment_not_helpful': return exactKeys(input, ['type', 'approval', 'spec_hash', 'artifact_hash', 'reason', 'evidence_summary', 'evidence_limits'])
      && Number.isInteger(input.approval) && input.approval >= 1 && hex(input.spec_hash) && hex(input.artifact_hash)
      && text(input.reason, 2000) && text(input.evidence_summary, 2000)
      && text(input.evidence_limits, 2000);
    case 'op_withdrew': return exactKeys(input, ['type', 'reason']) && text(input.reason, 2000);
    case 'credit_note': return exactKeys(input, ['type', 'person', 'source', 'note']) && text(input.person, 64) && hex(input.source) && text(input.note, 2000);
    case 'shelved': case 'checked_in':
      return exactKeys(input, input.type === 'checked_in' ? ['type', 'note', 'consent'] : ['type', input.type === 'shelved' ? 'reason' : 'note'])
        && text(input[input.type === 'shelved' ? 'reason' : 'note'], 2000)
        && (input.type !== 'checked_in' || input.consent === undefined || input.consent === true);
    case 'helped': return exactKeys(input, ['type', 'artifact_hash']) && hex(input.artifact_hash);
    case 'steward_changed': return exactKeys(input, ['type', 'steward', 'reason']) && text(input.steward, 64)
      && (input.reason === undefined || text(input.reason, 2000));
    case 'revised': return (exactKeys(input, ['type', 'text', 'base_hash']) ||
        (exactKeys(input, ['type', 'text', 'base_hash', 'credits']) && Array.isArray(input.credits)
          && input.credits.every(credit => credit && hex(credit.comment) && ['quoted', 'paraphrased'].includes(credit.mode))))
      && text(input.text, 4000) && hex(input.base_hash);
    case 'commented': return exactKeys(input, ['type', 'comment', 'anchor_kind', 'anchor_hash', 'parent', 'kind', 'resolves'])
      && text(input.comment, 4000) && ((input.anchor_kind === undefined && input.anchor_hash === undefined)
        || (['see', 'spec', 'artifact', 'send'].includes(input.anchor_kind) && hex(input.anchor_hash)))
      && (input.parent === undefined || hex(input.parent))
      && (input.kind === undefined || ['comment', 'question', 'concern', 'alternative', 'decline'].includes(input.kind))
      && (input.resolves === undefined || (input.resolves && typeof input.resolves === 'object'
        && typeof input.resolves.ledger_id === 'string' && /^ledger:[a-f0-9]{24}$/.test(input.resolves.ledger_id)
        && ['answers', 'contradicts', 'supports'].includes(input.resolves.claim)));
    case 'sent': case 'forked': case 'steered': return false;
    default: return false;
  }
};

const postBinding = req => ({ post_id: req.headers['x-post-id'], post_version: req.headers['x-post-version'] });

export function createHandler({ auth, store, integrations, questModel = null, secure = true, origin = 'https://localhost', clock = Date.now, log = () => {}, trustedProxy = false, canRead: readPolicy = defaultCanRead }) {
  integrations ||= new Integrations(store, { origin });
  const mentoring = new Mentoring(store, { clock });
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
      if (req.method === 'GET' && url.pathname === '/assets/mentoring.js') return staticFile(res, 'mentoring.js', 'application/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/assets/intelligence.js') return staticFile(res, 'intelligence.js', 'application/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/assets/app.css')
        return staticFile(res, 'app.css', 'text/css; charset=utf-8');
      if (req.method === 'GET' &&
          ['/assets/vision-quest.js', '/assets/quest-storage.js', '/assets/quest-ui.js', '/assets/reflection.js']
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
      const readable = item => session && canRead(session.person, item, readPolicy);
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
      if (req.method === 'GET' && url.pathname === '/intelligence') return page(res, intelligencePage());
      if (req.method === 'POST' && url.pathname === '/api/intelligence/package')
        return json(res, 200, evidencePackage(store, session.person, input, { clock }));
      if (req.method === 'POST' && url.pathname === '/api/intelligence/review') {
        if (!exactKeys(input, ['request', 'package_hash', 'answer']) || !hex(input.package_hash)) throw refused('analysis request required');
        const packet = evidencePackage(store, session.person, input.request, { clock });
        if (packet.hash !== input.package_hash) throw refused('sources changed; prepare a fresh package');
        return json(res, 200, readAnalysisAnswer(packet, input.answer));
      }
      if (req.method === 'GET' && url.pathname === '/mentoring')
        return page(res, mentoringHome(session.person, mentoring.opted(session.person), mentoring.directory(session.person), mentoring.list(session.person)));
      const evidenceView = url.pathname.match(/^\/mentoring\/evidence\/([^/]+)$/);
      if (req.method === 'GET' && evidenceView) {
        const evidence = mentoring.evidence(session.person, evidenceView[1]);
        return evidence ? page(res, mentoringEvidence(session.person, evidence)) : json(res, 404, { error: 'not found' });
      }
      const mentorView = url.pathname.match(/^\/mentoring\/([^/]+)$/);
      if (req.method === 'GET' && mentorView) {
        const request = mentoring.read(session.person, mentorView[1]);
        return request ? page(res, mentoringRequest(session.person, request, mentoring.checkins(session.person, request.id), mentoring.evidenceList(session.person, request.id))) : json(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST' && url.pathname === '/api/mentoring/optin') {
        if (!exactKeys(input, ['enabled']) || typeof input.enabled !== 'boolean') throw refused('explicit consent required');
        mentoring.optIn(session.person, input.enabled); return json(res, 201, { enabled: input.enabled });
      }
      if (req.method === 'POST' && url.pathname === '/api/mentoring/requests') {
        if (!exactKeys(input, ['mentor', 'objective'])) throw refused('mentor and objective required');
        return json(res, 201, { id: mentoring.request(session.person, input.mentor, input.objective) });
      }
      const mentorAction = url.pathname.match(/^\/api\/mentoring\/([^/]+)\/(decision|checkin|evidence)$/);
      if (req.method === 'POST' && mentorAction) {
        const [, id, action] = mentorAction;
        if (action === 'decision' && exactKeys(input, ['action'])) { mentoring.decide(session.person, id, input.action); return json(res, 201, { updated: true }); }
        if (action === 'checkin' && exactKeys(input, ['text'])) return json(res, 201, { id: mentoring.checkin(session.person, id, input.text) });
        if (action === 'evidence' && exactKeys(input, ['text', 'scope', 'shared_with']))
          return json(res, 201, { id: mentoring.addEvidence(session.person, id, input.text, { scope: input.scope, shared_with: input.shared_with ?? null }) });
        throw refused('request refused');
      }
      const revokeEvidence = url.pathname.match(/^\/api\/mentoring\/evidence\/([^/]+)\/revoke$/);
      if (req.method === 'POST' && revokeEvidence) {
        if (!exactKeys(input, [])) throw refused('request refused');
        mentoring.revoke(session.person, revokeEvidence[1]); return json(res, 201, { revoked: true });
      }
      if (req.method === 'GET' && url.pathname === '/search') {
        const query = url.searchParams.get('q') || '';
        return page(res, searchPage(query, store.search(session.person, query)));
      }
      const personView = url.pathname.match(/^\/people\/([^/]+)$/);
      if (req.method === 'GET' && personView) {
        const subject = decodeURIComponent(personView[1]);
        return page(res, contributionsPage(subject, store.contributions(session.person, subject)));
      }
      const recordView = url.pathname.match(/^\/items\/([^/]+)\/record\/([a-f0-9]{64})$/);
      if (req.method === 'GET' && recordView) {
        const event = store.events(recordView[1]).find(entry => entry.body_hash === recordView[2]);
        if (!event) return json(res, 404, { error: 'not found' });
        const erased = store.db.prepare('SELECT erased FROM bodies WHERE hash=?').get(recordView[2])?.erased === 1
          || !!store.db.prepare(`SELECT 1 FROM events e JOIN bodies b ON b.hash=e.body_hash
            WHERE e.item=? AND e.type='erased' AND json_extract(b.bytes,'$.body_hash')=?`).get(recordView[1], recordView[2]);
        const canAcknowledge = ['person', 'agent'].includes(store.db.prepare('SELECT kind FROM actors WHERE id=?').get(event.actor)?.kind);
        return page(res, recordPage(recordView[1], event, erased, canAcknowledge));
      }
      const relatedView = url.pathname.match(/^\/items\/([^/]+)\/related$/);
      if (req.method === 'GET' && relatedView) {
        const first = store.events(relatedView[1])[0];
        if (!first) return json(res, 404, { error: 'not found' });
        const query = (first.original || first.problem || '').match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 4).join(' ') || '';
        return page(res, searchPage(query, store.search(session.person, query).filter(row => row.item !== relatedView[1]), { related: true }));
      }
      const history = url.pathname.match(/^\/items\/([^/]+)\/history\/([^/]+)$/);
      if (req.method === 'GET' && history) {
        if (!readable(history[1])) return json(res, 403, { error: 'request refused' });
        const post = store.db.prepare('SELECT * FROM stage_posts WHERE item=? AND post_id=? AND closed_seq IS NOT NULL').get(history[1], decodeURIComponent(history[2]));
        if (!post) return json(res, 404, { error: 'not found' });
        const job = store.db.prepare('SELECT state FROM closeout_jobs WHERE item=? AND post_id=? AND snapshot_hash=?').get(history[1], post.post_id, post.snapshot_hash);
        const active = store.read(history[1]).context.activePost;
        const sources = active?.kind === 'spec' ? store.db.prepare("SELECT e.body_hash FROM events e JOIN bodies b ON b.hash=e.body_hash WHERE e.item=? AND e.type='commented' AND b.erased=0").all(history[1]).map(row => row.body_hash) : [];
        return page(res, frozenPostPage(history[1], post, store.events(history[1]), job, sources, store.knowledge.entries('annex').filter(row => row.body.parent?.item === history[1])));
      }
      const specView = url.pathname.match(/^\/items\/([^/]+)\/spec$/);
      if (req.method === 'GET' && specView) {
        const state = store.read(specView[1]);
        const sourceHash = url.searchParams.get('source_comment');
        const source = state.context.activePost?.kind === 'spec' && state.context.steward === session.person && /^[a-f0-9]{64}$/.test(sourceHash || '')
          ? store.db.prepare("SELECT b.bytes FROM events e JOIN bodies b ON b.hash=e.body_hash JOIN stage_posts p ON p.item=e.item AND p.post_id=json_extract(b.bytes,'$.post_id') WHERE e.item=? AND e.type='commented' AND e.body_hash=? AND b.erased=0 AND p.closed_seq IS NOT NULL").get(specView[1], sourceHash) : null;
        const sourceComment = source ? { ...JSON.parse(source.bytes), body_hash: sourceHash } : null;
        return page(res, specPage({ id: specView[1], ...state, sourceComment, effortAllowance: effortAllowance(store, session.person, specView[1], clock),
          workspaceResearch: store.db.prepare("SELECT enabled FROM research_config WHERE source='this_workspace'").get()?.enabled === 1,
          effort: store.db.prepare("SELECT kind,state,last_error,post_id FROM effort_jobs WHERE item=? AND kind='spec_draft' ORDER BY created").all(specView[1]),
          specPostId: state.context.rules === 3 ? store.db.prepare("SELECT post_id FROM stage_posts WHERE item=? AND kind='spec' ORDER BY opened_seq DESC LIMIT 1").get(specView[1])?.post_id : null }, store.events(specView[1]), session.person));
      }
      const view = url.pathname.match(/^\/items\/([^/]+)$/);
      if (req.method === 'GET' && view) {
        if (!readable(view[1])) return json(res, 403, { error: 'request refused' });
        const state = store.read(view[1]);
        const events = store.events(view[1]);
        if (state.state === 'SPECCED' && leader && state.context.steward !== session.person)
          auth.reviewApproval(sessionToken, view[1], state.context.specHash, events.length);
        return page(
          res,
          itemPage({ id: view[1], ...state,
            packet: (state.context.sent?.packetHash || state.context.decided?.packetHash)
              ? store.artifact(view[1], state.context.sent?.packetHash || state.context.decided.packetHash) : null,
            decisionPackets: Object.fromEntries(events.filter(event => ['approved', 'returned', 'not_built', 'decided'].includes(event.type) && event.packet_hash)
              .map(event => [event.packet_hash, store.artifact(view[1], event.packet_hash)])),
            effortAllowance: effortAllowance(store, session.person, view[1], clock),
            stagePosts: store.db.prepare('SELECT * FROM stage_posts WHERE item=? ORDER BY opened_seq, post_id').all(view[1]),
            annexes: store.knowledge.entries('annex').filter(row => row.body.parent?.item === view[1]),
            effort: store.db.prepare('SELECT kind,state,last_error,requester,created FROM effort_jobs WHERE item=? ORDER BY created').all(view[1]) }, events, session.person, leader),
        );
      }
      const updates = url.pathname.match(/^\/api\/items\/([^/]+)\/updates$/);
      if (req.method === 'GET' && updates) {
        if (!readable(updates[1])) return json(res, 403, { error: 'request refused' });
        return json(res, 200, { annexes: store.knowledge.entries('annex').filter(row => row.body.parent?.item === updates[1]).map(row => ({ hash: row.hash, body: row.body, responses: store.knowledge.entries('annex_response').filter(response => response.body.annex === row.hash) })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/digest') {
        const entries = store.db.prepare('SELECT * FROM digest_entries WHERE person=? ORDER BY created_at DESC').all(session.person)
          .filter(entry => { const annex = store.knowledge.entries('annex').find(row => row.hash === entry.annex_hash); return annex && readable(annex.body.parent.item); });
        return json(res, 200, { entries });
      }
      const annexResponse = url.pathname.match(/^\/api\/annexes\/([a-f0-9]{64})\/response$/);
      if (req.method === 'POST' && annexResponse) {
        if (!exactKeys(input, ['kind']) || !['relevant', 'not_relevant', 'mute'].includes(input.kind)) return json(res, 409, { error: 'request refused' });
        const annex = store.knowledge.entries('annex').find(row => row.hash === annexResponse[1]);
        if (!annex || !readable(annex.body.parent.item)) return json(res, 403, { error: 'request refused' });
        const at = new Date(clock()).toISOString();
        const response = store.knowledge.append('annex_response', { v: 1, annex: annex.hash, actor: session.person, kind: input.kind }, { at });
        if (input.kind === 'mute') store.db.prepare('INSERT OR IGNORE INTO reanalysis_mute(person) VALUES(?)').run(session.person);
        if (input.kind === 'not_relevant' && store.read(annex.body.parent.item).context.steward === session.person)
          store.db.prepare('DELETE FROM digest_entries WHERE person=? AND annex_hash=?').run(session.person, annex.hash);
        return json(res, 201, response);
      }
      const renew = url.pathname.match(/^\/api\/items\/([^/]+)\/renew$/);
      if (req.method === 'POST' && renew) {
        if (!exactKeys(input, ['annex', 'what_is_new', 'reason']) || !hex(input.annex) || !text(input.what_is_new, 2000) || !text(input.reason, 2000)) return json(res, 409, { error: 'request refused' });
        if (!readable(renew[1])) return json(res, 403, { error: 'request refused' });
        const key = req.headers['idempotency-key'] || randomUUID();
        const id = createHash('sha256').update(canonical(['renewal', session.person, renew[1], input.annex, key])).digest('hex');
        const point = store.forkPoint(renew[1], undefined, undefined, { extended: true });
        const result = store.append(id, { type: 'forked', actor: session.person, ...point, seed_policy: 2, rules: CURRENT_RULES, relation: 'renewal', basis: { annex: input.annex, what_is_new: input.what_is_new }, reason: input.reason, at: new Date(clock()).toISOString() }, { idem: key });
        return json(res, 201, { id, ...result });
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
            rules: CURRENT_RULES, at: new Date(clock()).toISOString() }, { idem });
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
        const questAsSee = Boolean(input.quest); // every Quest result posts a SEE: Effort replies and the thread opens
        if (prior.length) {
          if ((input.quest && prior[0].type !== (questAsSee ? 'posted' : 'checked')) || (!input.quest && prior[0].type !== 'checked') || prior[0].actor !== session.person) {
            throw invalid('Quest receipt owner does not match.');
          }
          return json(res, 200, { id, state: store.read(id), idempotent: true });
        }
        store.append(id, questAsSee ? { type: 'posted', actor: session.person, original: eventBody.problem,
          questMemo: eventBody.questMemo, rules: CURRENT_RULES, at: new Date(clock()).toISOString() } : { type: 'checked', actor: session.person,
          at: new Date(clock()).toISOString(), ...eventBody },
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
      const research = url.pathname.match(/^\/api\/items\/([^/]+)\/research$/);
      if (req.method === 'POST' && research) {
        if (!exactKeys(input, [])) return json(res, 409, { error: 'request refused' });
        const state = store.read(research[1]).context;
        if (state.steward !== session.person) throw refused('only the steward can refresh research');
        const at = new Date(clock()).toISOString();
        const events = store.events(research[1]);
        const current = events.filter(event => event.type === 'revised').at(-1)?.text || events[0]?.original || events[0]?.problem;
        const sources = await researchRecord({ at, connectors: workspaceConnectors(store, session.person), input: { item: research[1], text: current } });
        return json(res, 201, store.append(research[1], { type: 'researched', actor: session.person, sources, at, ...postBinding(req) },
          { idem: req.headers['idempotency-key'] || randomUUID() }));
      }
      const prepareSpec = url.pathname.match(/^\/api\/items\/([^/]+)\/spec-draft$/);
      if (req.method === 'POST' && prepareSpec) {
        if (!exactKeys(input, ['see_hash']) || !hex(input.see_hash)) throw refused('current SEE required');
        const draftContext = store.read(prepareSpec[1]).context;
        if (draftContext.rules === 3 && (req.headers['x-post-id'] !== draftContext.activePost?.id || req.headers['x-post-version'] !== draftContext.activePost?.version)) throw refused('frozen or superseded post');
        return json(res, 202, requestSpecDraft(store, session.person, prepareSpec[1], input.see_hash, clock));
      }
      const send = url.pathname.match(/^\/api\/items\/([^/]+)\/send$/);
      if (req.method === 'POST' && send) {
        if (!exactKeys(input, ['spec_hash', 'estimate']) || !hex(input.spec_hash)
          || (input.estimate !== undefined && !text(input.estimate, 2000))) return json(res, 409, { error: 'request refused' });
        const events = store.events(send[1]); const first = events[0];
        const spec = events.find(event => event.type === 'specced' && event.body_hash === input.spec_hash);
        const see = events.filter(event => event.type === 'revised').at(-1)?.text || first?.original;
        if (!first || !spec) throw refused('current spec required');
        const credits = events.filter(event => ['revised', 'specced'].includes(event.type))
          .flatMap(event => event.credits || []);
        const userEvidence = events.filter(event => ['posted', 'revised', 'specced', 'commented'].includes(event.type))
          .flatMap(event => event.evidence || []).map(evidence => ({ ...evidence }));
        const renewal = first.relation === 'renewal' ? first : null;
        const prior = renewal && store.events(renewal.parent.item).slice(0, renewal.parent.seq)
          .filter(event => ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)).at(-1);
        const packet = buildPacket({ original: first.original, see, spec: { ...spec, hash: input.spec_hash, rules: store.read(send[1]).context.rules }, credits,
          comments: events.filter(event => event.type === 'commented'), userEvidence, gatewayPolicy: {}, sandboxLimits: {},
          estimate: input.estimate ? { label: 'OP estimate, not independently verified', author: session.person, text: input.estimate } : undefined,
          researched: events.filter(event => event.type === 'researched').at(-1)?.sources,
          ...(renewal && prior ? { prior_decision: { outcome: prior.disposition || prior.verdict || prior.type, reason: prior.reason, who: prior.actor, when: prior.at }, new_information: { what_is_new: renewal.basis.what_is_new, annex: renewal.basis.annex } } : {}),
          lineage: first.type === 'forked' ? { ...first.parent, from: first.from || null, reason: first.reason || 'No reason recorded',
            parentDecision: store.events(first.parent.item).slice(0, first.parent.seq).filter(event => ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)).at(-1) || null } : null });
        const packet_hash = store.putArtifact(send[1], JSON.stringify(packet));
        const result = store.append(send[1], { type: 'sent', actor: session.person, spec_hash: input.spec_hash, packet_hash, ...postBinding(req),
          at: new Date().toISOString() }, { idem: req.headers['idempotency-key'] || randomUUID() });
        return json(res, 201, { ...result, packet_hash });
      }
      const reconcileFor = itemId => {
        const events = store.events(itemId);
        if (!events.length) throw refused('item not found');
        const state = store.read(itemId);
        const posts = store.db.prepare('SELECT post_id, opened_seq, closed_seq FROM stage_posts WHERE item=?').all(itemId);
        const terminal = !['SEEN', 'CHECKED', 'SPECCED', 'SUBMITTED', 'SENDING', 'TRYING'].includes(state.state);
        const inactivity = stewardInactivity(events, { posts, steward: state.context.steward, activePost: state.context.activePost, now: clock() });
        return { events, state, report: reconciliation(events, { posts, steward: state.context.steward, now: clock(), terminal }), inactivity };
      };
      const recon = url.pathname.match(/^\/api\/items\/([^/]+)\/reconciliation$/);
      if (req.method === 'GET' && recon) {
        const { report, state, inactivity } = reconcileFor(recon[1]);
        return json(res, 200, { ...report, steward: state.context.steward,
          you: forkEligibility(report, { person: session.person, steward: state.context.steward }),
          transfer: { ...inactivity, you: transferEligibility(report, inactivity, { person: session.person, steward: state.context.steward }) } });
      }
      const transferRequest = url.pathname.match(/^\/api\/items\/([^/]+)\/reconciliation\/transfer-request$/);
      if (req.method === 'POST' && transferRequest) {
        if (!exactKeys(input, ['reason']) || !text(input.reason, 2000)) return json(res, 409, { error: 'request refused' });
        const { report, state, inactivity } = reconcileFor(transferRequest[1]);
        const eligibility = transferEligibility(report, inactivity, { person: session.person, steward: state.context.steward });
        if (!eligibility.allowed) return json(res, 409, { error: 'request refused', reason: eligibility.reason,
          ...(eligibility.eligible_at ? { eligible_at: eligibility.eligible_at } : {}) });
        const active = state.context.activePost;
        if (!active) return json(res, 409, { error: 'request refused' });
        const result = store.append(transferRequest[1], { type: 'commented', actor: session.person,
          kind: 'transfer_request', comment: `Transfer requested: ${input.reason}`, anchor_kind: active.kind,
          anchor_hash: active.version, ...postBinding(req), at: new Date(clock()).toISOString() },
        { idem: req.headers['idempotency-key'] || randomUUID() });
        return json(res, 201, { ...result, transfer: eligibility });
      }
      const fork = url.pathname.match(/^\/api\/items\/([^/]+)\/fork$/);
      if (req.method === 'POST' && fork) {
        if (!exactKeys(input, ['reason', 'from']) || !text(input.reason, 2000)
          || (input.from !== undefined && (!input.from || !exactKeys(input.from, ['kind', 'hash', 'post_id'])
            || !['see', 'spec', 'artifact', 'snapshot'].includes(input.from.kind) || !hex(input.from.hash)
            || (input.from.kind === 'snapshot' ? !text(input.from.post_id, 160) : input.from.post_id !== undefined)))) return json(res, 409, { error: 'request refused' });
        const key = req.headers['idempotency-key'] || randomUUID();
        const id = createHash('sha256').update(canonical(['fork-request', session.person, fork[1], key])).digest('hex');
        const existing = store.events(id)[0];
        if (existing) {
          if (existing.reason !== input.reason || canonical(existing.from) !== canonical(input.from)) throw refused('fork request conflict');
          return json(res, 200, { id, ...store.read(id), idempotent: true });
        }
        const point = store.forkPoint(fork[1], input.from, undefined, { extended: true });
        const { report, state: parentState } = reconcileFor(fork[1]);
        const eligibility = forkEligibility(report, { person: session.person, steward: parentState.context.steward });
        if (!eligibility.allowed) return json(res, 409, { error: 'request refused', reason: eligibility.reason, ...(eligibility.not_before ? { not_before: eligibility.not_before } : {}) });
        const result = store.append(id, { type: 'forked', actor: session.person, ...point, seed_policy: 2, rules: CURRENT_RULES, reason: input.reason,
          ...(input.from ? { from: input.from } : {}), at: new Date(clock()).toISOString() }, { idem: key });
        return json(res, 201, { id, ...result });
      }
      const steer = url.pathname.match(/^\/api\/items\/([^/]+)\/steer$/);
      if (req.method === 'POST' && steer) {
        if (!exactKeys(input, ['instruction', 'source', 'mode', 'scope']) || !text(input.instruction, 4000)
          || (input.source !== undefined && !hex(input.source))
          || (input.mode !== undefined && !['quoted', 'paraphrased'].includes(input.mode))
          || (input.scope !== undefined && !validScope(input.scope))) return json(res, 409, { error: 'request refused' });
        const context = store.read(steer[1]).context;
        const result = store.append(steer[1], { type: 'steered', actor: session.person, instruction: input.instruction, ...postBinding(req),
          ...(input.source ? { source: input.source, mode: input.mode || 'paraphrased' } : {}), approval: context.approval,
          spec_hash: context.specHash, ...(input.scope ? { scope: input.scope } : {}), at: new Date().toISOString() }, { idem: req.headers['idempotency-key'] || randomUUID() });
        return json(res, 201, result);
      }
      const erase = url.pathname.match(/^\/api\/items\/([^/]+)\/erase$/);
      if (req.method === 'POST' && erase) {
        if (!exactKeys(input, ['body_hash', 'ground', 'note']) || !hex(input.body_hash)
          || (input.ground !== undefined && !['privacy', 'legal', 'safety', 'customer or employee personal data'].includes(input.ground))
          || (input.note !== undefined && !text(input.note, 2000))) return json(res, 409, { error: 'request refused' });
        store.erase(erase[1], input.body_hash, session.person, new Date(clock()).toISOString(),
          input.ground ? { ground: input.ground, note: input.note } : {});
        return json(res, 201, { erased: input.body_hash });
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
      const closeout = url.pathname.match(/^\/api\/items\/([^/]+)\/closeout\/([^/]+)$/);
      if (req.method === 'GET' && closeout) {
        const job = store.db.prepare("SELECT artifact_hash FROM closeout_jobs WHERE item=? AND post_id=? AND state='done'")
          .get(closeout[1], decodeURIComponent(closeout[2]));
        const bytes = job?.artifact_hash && store.artifact(closeout[1], job.artifact_hash);
        if (!bytes) return json(res, 404, { error: 'not found' });
        return json(res, 200, JSON.parse(bytes));
      }
      const deliver = url.pathname.match(/^\/api\/items\/([^/]+)\/artifact$/);
      if (req.method === 'POST' && deliver) {
        const state = store.read(deliver[1]);
        if (!(leader || state.context.steward === session.person))
          throw refused('event not allowed');
        // Check the stage before storing any bytes, so a refused delivery leaves nothing behind.
        if (state.state !== 'SENDING') throw refused('event not allowed');
        if (state.context.rules === 3 && (req.headers['x-post-id'] !== state.context.activePost?.id || req.headers['x-post-version'] !== state.context.activePost?.version)) throw refused('frozen or superseded post');
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
      if (['returned', 'not_built'].includes(input.type) && store.read(match[1]).context.rules >= 3)
        throw refused('legacy decision type unavailable for current rules');
      if (input.type === 'specced' && store.read(match[1]).context.rules >= 2) input = { ...input, scope: input.scope || emptyScope() };
      if (input.type === 'approved' && input.spec_hash === undefined && store.read(match[1]).context.rules === 3) throw refused('reviewed packet required');
      if (input.type === 'approved' && input.spec_hash === undefined) {
        // Older API clients did not carry the rendered binding. Bind them to the
        // current record here; a browser that has seen Decide must echo its view.
        if (auth.approvalReview(sessionToken, match[1]))
          return json(res, 409, { error: 'request refused' });
        const state = store.read(match[1]);
        input = { ...input, spec_hash: state.context.specHash, expected_seq: store.eventRows(match[1]).length };
      }
      const eventAt = new Date(clock()).toISOString();
      if (input.type === 'approved' && input.spec_hash !== undefined) {
        const minutes = input.window_minutes ?? 7 * 24 * 60;
        const expiry = new Date(Date.parse(eventAt) + minutes * 60_000);
        if (!Number.isFinite(expiry.getTime())) return json(res, 409, { error: 'request refused' });
        input = { ...input, window_minutes: minutes, expires_at: expiry.toISOString() };
      }
      if (['returned', 'not_built'].includes(input.type)) {
        const state = store.read(match[1]).context;
        if (state.rules === 3 && (!input.spec_hash || !input.packet_hash)) throw refused('reviewed packet required');
        if ((input.spec_hash !== undefined && input.spec_hash !== state.sent?.specHash)
          || (input.packet_hash !== undefined && input.packet_hash !== state.sent?.packetHash))
          return json(res, 409, { error: 'request refused' });
        input = { ...input, spec_hash: state.sent?.specHash, packet_hash: state.sent?.packetHash };
      }
      if (input.type === 'commented') {
        const state = store.read(match[1]).context;
        const current = { see: state.seeHash,
          spec: state.specSeeHash === state.seeHash ? state.specHash : null, artifact: state.artifact,
          ...(state.rules === 3 && state.activePost?.kind === 'send' ? { send: state.activePost.version } : {}) };
        if (current[input.anchor_kind] !== input.anchor_hash) {
          return json(res, 409, { error: state.rules === 3 ? 'frozen or superseded post' : 'request refused' });
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
          { ...input, actor: session.person, at: eventAt, ...postBinding(req) },
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
      if (kind === 'refused') return json(res, 409, { error: error.message === 'frozen or superseded post' ? error.message : 'request refused' });
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
