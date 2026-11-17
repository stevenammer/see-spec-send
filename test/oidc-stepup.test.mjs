import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { FakeOidcProvider, OidcLogin } from '../app/oidc.js';

const issuer = 'https://idp.example.test', redirect = 'https://sss.example.test/api/oidc/callback';
function setup(t, clock = { now: 1_800_000_000_000 }) {
  const provider = new FakeOidcProvider({ issuer, clock: () => clock.now });
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store, { clock: () => clock.now, oidc: new OidcLogin(provider.configuration(redirect), { clock: () => clock.now }) });
  return { provider, store, auth, clock };
}
async function signIn({ auth, provider }, subject, binder) {
  const url = new URL(auth.beginOidc(binder));
  const code = provider.issue({ codeChallenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce'), subject });
  return auth.completeOidc({ state: url.searchParams.get('state'), code, binder });
}
const answer = (provider, url, subject, authTime) => provider.issue({ codeChallenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce'), subject, authTime });

test('a single-sign-on session can step up only by signing in again, and the proof is single use', async t => {
  const env = setup(t); const { auth, provider, clock } = env;
  const login = await signIn(env, 'sso-leader', 'b1');
  assert.equal(auth.useStepup(login.value), false, 'no step-up until the person signs in again');
  assert.equal(auth.stepupFresh(login.value), false);
  const url = new URL(auth.beginOidcStepup(login.value, 'b2', '/items/abc'));
  assert.equal(url.searchParams.get('prompt'), 'login'); assert.equal(url.searchParams.get('max_age'), '0');
  clock.now += 5000;
  const done = await auth.completeOidcStepup(login.value, { state: url.searchParams.get('state'), code: answer(provider, url, 'sso-leader', Math.floor(clock.now / 1000)), binder: 'b2' });
  assert.equal(done.next, '/items/abc');
  assert.equal(auth.stepupFresh(login.value), true);
  assert.equal(auth.useStepup(login.value), true);
  assert.equal(auth.useStepup(login.value), false, 'consumed');
});

test('step-up refuses: an old provider session, a different person, another session, another browser, and a login used as step-up', async t => {
  const env = setup(t); const { auth, provider, clock } = env;
  const login = await signIn(env, 'person-a', 'b1'), other = await signIn(env, 'person-b', 'b9');
  let n = 0; const start = binder => { clock.now += 60_000; return new URL(auth.beginOidcStepup(login.value, binder, null, `10.0.0.${n++}`)); };  // fresh address each time: the per-person limit is tested elsewhere
  const now = () => Math.floor(clock.now / 1000);
  let u = start('c1');
  await assert.rejects(auth.completeOidcStepup(login.value, { state: u.searchParams.get('state'), code: answer(provider, u, 'person-a', now() - 3600), binder: 'c1' }), /refused|unavailable/, 'stale auth_time');
  u = start('c2');
  await assert.rejects(auth.completeOidcStepup(login.value, { state: u.searchParams.get('state'), code: answer(provider, u, 'person-a', undefined), binder: 'c2' }), /refused|unavailable/, 'no auth_time at all');
  u = start('c3');
  await assert.rejects(auth.completeOidcStepup(login.value, { state: u.searchParams.get('state'), code: answer(provider, u, 'person-b', now()), binder: 'c3' }), /refused|unavailable/, 'someone else signed in');
  u = start('c4');
  await assert.rejects(auth.completeOidcStepup(other.value, { state: u.searchParams.get('state'), code: answer(provider, u, 'person-a', now()), binder: 'c4' }), /refused|unavailable/, 'another session cannot use it');
  u = start('c5');
  await assert.rejects(auth.completeOidcStepup(login.value, { state: u.searchParams.get('state'), code: answer(provider, u, 'person-a', now()), binder: 'wrong' }), /refused|unavailable/, 'another browser');
  assert.equal(auth.stepupFresh(login.value), false, 'none of those left any step-up behind');
  // A step-up answer can never become a sign-in.
  u = start('c6');
  await assert.rejects(auth.completeOidc({ state: u.searchParams.get('state'), code: answer(provider, u, 'person-a', now()), binder: 'c6' }), /refused/);
  // Password sessions cannot start the single-sign-on path.
  await auth.createUser('pw', 'fixture-password-123', true);
  const pw = await auth.login('pw', 'fixture-password-123');
  clock.now += 60_000;
  assert.throws(() => auth.beginOidcStepup(pw.value, 'd1', null), /unavailable/);
});

import { Readable } from 'node:stream';
import { createHandler } from '../app/http.js';
class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))); } end(v = '') { this.text += v; } }
async function http(handler, method, path, cookie = '') {
  const req = Readable.from([]); req.method = method; req.url = path; req.headers = { host: 'sss.example.test', ...(cookie ? { cookie } : {}) }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Res(); await handler(req, res); return res;
}
const cookiePair = res => [].concat(res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

test('over HTTP: step-up start needs a session and a local return path, the callback returns to the item, and a login callback is not mistaken for it', async t => {
  const env = setup(t); const { auth, provider, store } = env;
  const handler = createHandler({ store, auth, secure: false, disablePasswordLogin: true });
  assert.equal((await http(handler, 'GET', '/api/oidc/stepup/start')).status, 404, 'no session');
  // Sign in over HTTP.
  const start = await http(handler, 'GET', '/api/oidc/start'); const loginUrl = new URL(start.headers.location);
  const code = provider.issue({ codeChallenge: loginUrl.searchParams.get('code_challenge'), nonce: loginUrl.searchParams.get('nonce'), subject: 'http-person', authTime: Math.floor(env.clock.now / 1000) });
  const back = await http(handler, 'GET', `/api/oidc/callback?state=${loginUrl.searchParams.get('state')}&code=${code}`, cookiePair(start));
  assert.equal(back.status, 302); const session = cookiePair(back);
  for (const bad of ['https://evil.example/', '//evil.example', '/items/a/b', '/api/items/x', 'javascript:1'])
    assert.equal((await http(handler, 'GET', `/api/oidc/stepup/start?next=${encodeURIComponent(bad)}`, session)).status, 400, bad);
  const up = await http(handler, 'GET', '/api/oidc/stepup/start?next=%2Fitems%2Fabc', session);
  assert.equal(up.status, 302); const upUrl = new URL(up.headers.location); assert.equal(upUrl.searchParams.get('prompt'), 'login');
  const upCode = provider.issue({ codeChallenge: upUrl.searchParams.get('code_challenge'), nonce: upUrl.searchParams.get('nonce'), subject: 'http-person', authTime: Math.floor(env.clock.now / 1000) });
  const cb = `/api/oidc/callback?state=${upUrl.searchParams.get('state')}&code=${upCode}`;
  assert.equal((await http(handler, 'GET', cb, cookiePair(up))).status, 400, 'no session cookie with it');
  const ok = await http(handler, 'GET', cb.replace(/state=[^&]+/, `state=${new URL((await http(handler, 'GET', '/api/oidc/stepup/start?next=%2Fitems%2Fabc', session)).headers.location).searchParams.get('state')}`), session);
  assert.equal(ok.status, 400, 'a code issued for one request cannot finish another');
});

test('over HTTP: a real step-up round trip returns to the item and leaves one usable approval proof', async t => {
  const env = setup(t); const { auth, provider, store } = env;
  const handler = createHandler({ store, auth, secure: false, disablePasswordLogin: true });
  const start = await http(handler, 'GET', '/api/oidc/start'); const l = new URL(start.headers.location);
  const code = provider.issue({ codeChallenge: l.searchParams.get('code_challenge'), nonce: l.searchParams.get('nonce'), subject: 'rt-person', authTime: Math.floor(env.clock.now / 1000) });
  const session = cookiePair(await http(handler, 'GET', `/api/oidc/callback?state=${l.searchParams.get('state')}&code=${code}`, cookiePair(start)));
  const up = await http(handler, 'GET', '/api/oidc/stepup/start?next=%2Fitems%2Fabc', session); const u = new URL(up.headers.location);
  const upCode = provider.issue({ codeChallenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce'), subject: 'rt-person', authTime: Math.floor(env.clock.now / 1000) });
  const binder = cookiePair(up);
  const done = await http(handler, 'GET', `/api/oidc/callback?state=${u.searchParams.get('state')}&code=${upCode}`, `${session}; ${binder}`);
  assert.equal(done.status, 302); assert.equal(done.headers.location, '/items/abc');
  const token = /(?:^|; )sss=([^;]+)/.exec(session)[1]; assert.equal(auth.stepupFresh(token), true);
  assert.equal(auth.useStepup(token), true); assert.equal(auth.useStepup(token), false);
});

test('a step-up started in one session cannot be finished from a later session of the same person', async t => {
  const env = setup(t); const { auth, provider, clock } = env;
  const first = await signIn(env, 'same-person', 'e1');
  const url = new URL(auth.beginOidcStepup(first.value, 'e2', null));
  clock.now += 61_000;
  const second = await signIn(env, 'same-person', 'e3');      // signing in again replaces the first session
  await assert.rejects(auth.completeOidcStepup(second.value, { state: url.searchParams.get('state'), code: answer(provider, url, 'same-person', Math.floor(clock.now / 1000)), binder: 'e2' }), /unavailable/);
  assert.equal(auth.stepupFresh(second.value), false);
});
