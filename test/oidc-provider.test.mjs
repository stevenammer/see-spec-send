import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { OidcLogin } from '../app/oidc.js';
import { OidcProvider, validateOidcConfig } from '../app/oidc-provider.js';

// An in-process identity provider that signs real tokens. Every network call goes through an injected fetch, so
// no socket is opened and nothing leaves the process.
const ISSUER = 'https://idp.example.test', CLIENT = 'sss-client', REDIRECT = 'https://sss.example.test/api/oidc/callback';
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }), rsa2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (key, kid, alg) => ({ ...key.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
const NOW = Date.parse('2026-11-16T12:00:00Z'), sec = Math.floor(NOW / 1000);

function idp(overrides = {}) {
  const state = { keys: [jwk(rsa, 'rsa-1', 'RS256'), jwk(ec, 'ec-1', 'ES256')], calls: [], discovery: {}, tokenResponse: null, bodyOverride: null, status: {}, ...overrides };
  const respond = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, body: new Response(typeof value === 'string' ? value : JSON.stringify(value)).body });
  state.fetch = async (url, request = {}) => {
    const key = url.toString(); state.calls.push({ url: key, method: request.method || 'GET', body: request.body, headers: request.headers });
    if (state.status[key]) return respond('', state.status[key]);
    if (state.bodyOverride?.[key]) return respond(state.bodyOverride[key]);
    if (key === `${ISSUER}/.well-known/openid-configuration`) return respond({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, ...state.discovery });
    if (key === `${ISSUER}/jwks`) return respond({ keys: state.keys });
    if (key === `${ISSUER}/token`) return respond(typeof state.tokenResponse === 'function' ? state.tokenResponse(request) : state.tokenResponse);
    return respond('', 404);
  };
  return state;
}
const baseClaims = nonce => ({ iss: ISSUER, aud: CLIENT, sub: 'subject-1', nonce, iat: sec, exp: sec + 600, email: 'dana@example.test', email_verified: true });
const token = (claims, { alg = 'RS256', kid = alg === 'RS256' ? 'rsa-1' : 'ec-1', key = alg === 'RS256' ? rsa.privateKey : ec.privateKey, header = {} } = {}) => {
  const head = b64({ alg, kid, typ: 'JWT', ...header }), body = b64(claims), data = Buffer.from(`${head}.${body}`);
  const signature = alg === 'RS256' ? sign('RSA-SHA256', data, key) : sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
};
const config = (extra = {}) => ({ issuer: ISSUER, clientId: CLIENT, clientSecretEnv: 'TEST_OIDC_SECRET', redirectUri: REDIRECT, hosts: ['idp.example.test', 'sss.example.test'], ...extra });
const env = { TEST_OIDC_SECRET: 'super-secret-value' };
const resolver = async () => [{ address: '93.184.216.34' }];
async function setup(server = idp(), cfg = config(), clock = () => NOW) {
  const provider = await OidcProvider.create(cfg, { env, fetch: server.fetch, resolver, clock, secure: true });
  const login = new OidcLogin(provider.loginConfig(), { clock });
  return { server, provider, login };
}
// Runs start -> callback with a token the test controls; returns the result or the refusal message.
async function signIn({ server, login }, makeToken, { binder = 'browser-1', callbackBinder = binder, state: overrideState } = {}) {
  const url = new URL(login.begin(binder)); const state = url.searchParams.get('state'), nonce = url.searchParams.get('nonce');
  server.tokenResponse = { id_token: typeof makeToken === 'function' ? makeToken(nonce) : makeToken };
  try { return { ok: await login.complete({ state: overrideState ?? state, code: 'code-1', binder: callbackBinder }), url, nonce }; }
  catch (error) { return { error: error.message, url, nonce }; }
}

test('a valid sign-in works end to end, with PKCE, state and nonce, and the client secret is sent only in the token request body', async () => {
  const ctx = await setup(); const result = await signIn(ctx, nonce => token(baseClaims(nonce)));
  assert.equal(result.error, undefined); assert.match(result.ok.id, /^oidc-[a-f0-9]{32}$/);
  assert.equal(result.url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(result.url.searchParams.get('scope'), 'openid email');
  const tokenCall = ctx.server.calls.find(call => call.url.endsWith('/token'));
  assert.match(tokenCall.body, /code_verifier=/); assert.match(tokenCall.body, /client_secret=super-secret-value/);
  for (const call of ctx.server.calls.filter(c => !c.url.endsWith('/token'))) assert.ok(!JSON.stringify(call).includes('super-secret-value'), 'the secret is never sent to discovery or JWKS');
});

test('ES256 tokens verify too, and client_secret_basic sends the secret in a header instead of the body', async () => {
  const ctx = await setup(idp(), config({ clientAuth: 'client_secret_basic' }));
  const ok = await signIn(ctx, nonce => token(baseClaims(nonce), { alg: 'ES256' })); assert.equal(ok.error, undefined);
  const call = ctx.server.calls.find(c => c.url.endsWith('/token'));
  assert.match(call.headers.authorization, /^Basic /); assert.ok(!call.body.includes('super-secret-value'));
});

test('every kind of bad token is refused with a generic message that never contains the secret', async () => {
  const ctx = await setup(); const cases = {
    'wrong issuer': nonce => token({ ...baseClaims(nonce), iss: 'https://evil.example.test' }),
    'wrong audience': nonce => token({ ...baseClaims(nonce), aud: 'someone-else' }),
    'wrong nonce': () => token(baseClaims('not-the-nonce')),
    'expired': nonce => token({ ...baseClaims(nonce), iat: sec - 4000, exp: sec - 3000 }),
    'not yet valid': nonce => token({ ...baseClaims(nonce), nbf: sec + 3600 }),
    'lifetime over an hour': nonce => token({ ...baseClaims(nonce), exp: sec + 7200 }),
    'issued in the future': nonce => token({ ...baseClaims(nonce), iat: sec + 3600, exp: sec + 4000 }),
    'alg none': nonce => `${b64({ alg: 'none', kid: 'rsa-1' })}.${b64(baseClaims(nonce))}.`,
    'HS256 using the public key as the secret': nonce => { const head = b64({ alg: 'HS256', kid: 'rsa-1' }), body = b64(baseClaims(nonce)); return `${head}.${body}.${createHmac('sha256', JSON.stringify(jwk(rsa, 'rsa-1', 'RS256'))).update(`${head}.${body}`).digest('base64url')}`; },
    'unknown key id': nonce => token(baseClaims(nonce), { kid: 'missing' }),
    'alg that does not match the key': nonce => token(baseClaims(nonce), { alg: 'ES256', kid: 'rsa-1', key: ec.privateKey }),
    'a key URL in the header': nonce => token(baseClaims(nonce), { header: { jku: 'https://evil.example.test/jwks' } }),
    'an embedded key in the header': nonce => token(baseClaims(nonce), { header: { jwk: jwk(rsa2, 'x', 'RS256') } }),
    'signed by another key': nonce => token(baseClaims(nonce), { key: rsa2.privateKey }),
    'tampered payload': nonce => { const [h, , s] = token(baseClaims(nonce)).split('.'); return `${h}.${b64({ ...baseClaims(nonce), sub: 'admin' })}.${s}`; },
    'two audiences without azp': nonce => token({ ...baseClaims(nonce), aud: [CLIENT, 'other'] }),
    'missing subject': nonce => token({ ...baseClaims(nonce), sub: '' }),
    'unverified email': nonce => token({ ...baseClaims(nonce), email_verified: false }),
    'garbage': () => 'not-a-token',
    'oversized': () => `${'a'.repeat(20000)}.b.c`,
  };
  for (const [name, make] of Object.entries(cases)) {
    const result = await signIn(ctx, make);
    assert.ok(result.error, `${name} must be refused`); assert.ok(!/super-secret-value/.test(result.error), name);
    assert.match(result.error, /refused/i, name);
  }
});

test('discovery is strict: issuer must match exactly, endpoints must be https on allowed hosts, redirects and oversize bodies are refused', async () => {
  const create = server => OidcProvider.create(config(), { env, fetch: server.fetch, resolver, clock: () => NOW, secure: true });
  await assert.rejects(create(idp({ discovery: { issuer: 'https://other.example.test' } })), /refused/);
  await assert.rejects(create(idp({ discovery: { token_endpoint: 'http://idp.example.test/token' } })), /refused/);
  await assert.rejects(create(idp({ discovery: { jwks_uri: 'https://elsewhere.example.test/jwks' } })), /refused/, 'a host outside the allowlist');
  await assert.rejects(create(idp({ status: { [`${ISSUER}/.well-known/openid-configuration`]: 302 } })), /refused/, 'a redirect is a failure');
  await assert.rejects(create(idp({ bodyOverride: { [`${ISSUER}/.well-known/openid-configuration`]: 'x'.repeat(200_000) } })), /refused/, 'oversize');
  await assert.rejects(create(idp({ bodyOverride: { [`${ISSUER}/.well-known/openid-configuration`]: 'not json' } })), /refused/);
});

test('configuration is validated: unknown fields, missing secret, plain http, and insecure loopback in secure mode are all refused', () => {
  const ok = c => validateOidcConfig(c, { secure: true, env });
  ok(config());
  assert.throws(() => ok(config({ extra: 1 })), /unknown field/);
  assert.throws(() => validateOidcConfig(config(), { secure: true, env: {} }), /secret is unavailable/);
  assert.throws(() => ok(config({ issuer: 'http://idp.example.test' })), /refused/);
  assert.throws(() => ok(config({ hosts: [] })), /hosts/);
  assert.throws(() => ok(config({ clockSkewSeconds: 301 })), /skew/);
  assert.throws(() => ok(config({ clientAuth: 'private_key_jwt' })), /authentication/);
  assert.throws(() => ok(config({ clientSecretEnv: 'lowercase' })), /environment variable/);
  assert.throws(() => ok(config({ scopes: ['email'] })), /scopes|OIDC/, 'openid is required');
  assert.throws(() => ok(config({ allowInsecureLoopbackForDevelopment: true })), /refused in --secure mode/);
  assert.equal(validateOidcConfig(config({ issuer: 'http://127.0.0.1', redirectUri: 'http://127.0.0.1/cb', hosts: ['127.0.0.1'], allowInsecureLoopbackForDevelopment: true }), { secure: false, env }).allowInsecureLoopbackForDevelopment, true);
});

test('state is single use, tied to the browser that started it, and a callback with no start is refused', async () => {
  const ctx = await setup();
  assert.ok((await signIn(ctx, nonce => token(baseClaims(nonce)), { callbackBinder: 'a-different-browser' })).error, 'another browser cannot finish this login');
  assert.ok((await signIn(ctx, nonce => token(baseClaims(nonce)), { state: 'never-issued' })).error, 'a state that was never issued');
  const url = new URL(ctx.login.begin('b1')); const state = url.searchParams.get('state'), nonce = url.searchParams.get('nonce');
  ctx.server.tokenResponse = { id_token: token(baseClaims(nonce)) };
  assert.ok(await ctx.login.complete({ state, code: 'c', binder: 'b1' }));
  await assert.rejects(ctx.login.complete({ state, code: 'c', binder: 'b1' }), /refused/, 'replaying the same state');
  await assert.rejects(ctx.login.complete({ state: '', code: 'c', binder: 'b1' }), /refused/);
});

test('keys: a rotated key triggers one bounded refetch, and a flood of unknown key ids does not hammer the provider', async () => {
  let clock = NOW; const server = idp(); const ctx = await setup(server, config(), () => clock);
  assert.equal((await signIn(ctx, nonce => token(baseClaims(nonce)))).error, undefined);
  const jwksCalls = () => server.calls.filter(c => c.url.endsWith('/jwks')).length; const before = jwksCalls();
  server.keys = [...server.keys, jwk(rsa2, 'rsa-2', 'RS256')];                         // the provider rotates in a new key
  assert.equal((await signIn(ctx, nonce => token(baseClaims(nonce), { kid: 'rsa-2', key: rsa2.privateKey }))).error, undefined, 'the new key is picked up');
  assert.equal(jwksCalls(), before + 1);
  for (let n = 0; n < 25; n += 1) await signIn(ctx, nonce => token(baseClaims(nonce), { kid: `bogus-${n}` }));
  assert.ok(jwksCalls() <= before + 1, 'unknown key ids inside a minute never trigger another fetch');
  clock += 61_000;
  await signIn(ctx, nonce => token({ ...baseClaims(nonce), iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 600 }, { kid: 'still-unknown' }));
  assert.equal(jwksCalls(), before + 2, 'after a minute one more refetch is allowed');
});

test('tenant pinning, email domain and verified email rules, and a domain rule cannot be skipped by omitting the email', async () => {
  const pinned = await setup(idp(), config({ tenantId: 'tenant-1' }));
  assert.ok((await signIn(pinned, nonce => token(baseClaims(nonce)))).error, 'no tid claim is refused when a tenant is pinned');
  assert.ok((await signIn(pinned, nonce => token({ ...baseClaims(nonce), tid: 'tenant-2' }))).error);
  assert.equal((await signIn(pinned, nonce => token({ ...baseClaims(nonce), tid: 'tenant-1' }))).error, undefined);
  const domain = await setup(idp(), config({ allowedEmailDomains: ['example.test'] }));
  assert.equal((await signIn(domain, nonce => token(baseClaims(nonce)))).error, undefined);
  assert.ok((await signIn(domain, nonce => token({ ...baseClaims(nonce), email: 'x@example.org' }))).error, 'another domain');
  const { email, email_verified, ...noEmail } = baseClaims('x');
  assert.ok((await signIn(domain, nonce => token({ ...noEmail, nonce }))).error, 'a token with no email cannot satisfy a domain rule');
});

test('provisioning: nobody is created unless autoProvision is on, and a leader is never made from claims', async () => {
  const store = new Store(); const auth = new Auth(store);
  const strict = await setup(); auth.oidc = strict.login;
  const server = strict.server; const begin = () => new URL(auth.beginOidc('b-1'));
  let url = begin(); server.tokenResponse = { id_token: token(baseClaims(url.searchParams.get('nonce'))) };
  await assert.rejects(auth.completeOidc({ state: url.searchParams.get('state'), code: 'c', binder: 'b-1' }), /not provisioned/);
  const open = await setup(idp(), config({ autoProvision: true })); auth.oidc = open.login;
  url = new URL(auth.beginOidc('b-2')); open.server.tokenResponse = { id_token: token({ ...baseClaims(url.searchParams.get('nonce')), is_admin: true, groups: ['admins'], roles: ['leader'], leader: true }) };
  const session = await auth.completeOidc({ state: url.searchParams.get('state'), code: 'c', binder: 'b-2' });
  assert.ok(session.value);
  const person = store.db.prepare("SELECT id FROM actors WHERE id LIKE 'oidc-%'").get();
  assert.equal(store.actor(person.id, '').leader, false, 'claims can never grant leadership');
  store.close();
});

test('clock skew: a token that expired a few seconds ago is accepted only inside the configured leeway, and zero means strict', async () => {
  const expiredBy = seconds => nonce => token({ ...baseClaims(nonce), iat: sec - seconds - 100, exp: sec - seconds });
  const lenient = await setup();                                                    // default 60 seconds
  assert.equal((await signIn(lenient, expiredBy(30))).error, undefined, 'inside the leeway');
  assert.ok((await signIn(lenient, expiredBy(200))).error, 'beyond the leeway');
  const strict = await setup(idp(), config({ clockSkewSeconds: 0 }));
  assert.ok((await signIn(strict, expiredBy(5))).error, 'with zero skew even a few seconds late is refused');
  assert.equal((await signIn(strict, nonce => token(baseClaims(nonce)))).error, undefined);
});

test('startup fails loudly when the key endpoint is unreachable, instead of failing later at sign-in', async () => {
  await assert.rejects(OidcProvider.create(config(), { env, fetch: idp({ status: { [`${ISSUER}/jwks`]: 500 } }).fetch, resolver, clock: () => NOW, secure: true }), /refused/);
});

import { Readable } from 'node:stream';
import { createHandler } from '../app/http.js';
async function request(handler, method, path, { body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); req.method = method; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: 'http://localhost' }), ...headers };
  const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(c, h = {}) { this.status = c; Object.assign(this.headers, h); }, end(v = '') { this.text += v; } };
  await handler(req, res); return res;
}

test('with password login disabled the server refuses it itself, the sign-in page offers only the identity provider, and the OIDC start still works', async () => {
  const store = new Store(), auth = new Auth(store); await auth.createUser('someone', 'a-long-test-passphrase-9x', false);
  const ctx = await setup(); auth.oidc = ctx.login;
  const open = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const closed = createHandler({ store, auth, secure: false, origin: 'http://localhost', disablePasswordLogin: true });
  assert.notEqual((await request(open, 'POST', '/api/login', { body: { id: 'someone', password: 'a-long-test-passphrase-9x' } })).status, 404, 'password login normally works');
  assert.equal((await request(closed, 'POST', '/api/login', { body: { id: 'someone', password: 'a-long-test-passphrase-9x' } })).status, 404, 'refused by the server, not just hidden');
  const page = await request(closed, 'GET', '/signin');
  assert.ok(!page.text.includes('/api/login'), 'no password form'); assert.ok(page.text.includes('/api/oidc/start'), 'the provider link is offered');
  const start = await request(closed, 'GET', '/api/oidc/start');
  assert.equal(start.status, 302); assert.match(start.headers.location, /^https:\/\/idp\.example\.test\/authorize\?/);
  assert.match(start.headers['set-cookie'], /HttpOnly/);
  store.close();
});

test('the provider verifies audience, nonce and key algorithm on its own, not only through the login flow that re-checks them', async () => {
  const { provider } = await setup();
  const good = token(baseClaims('n-1'));
  assert.equal((await provider.verifyIdToken(good, { nonce: 'n-1' })).sub, 'subject-1');
  await assert.rejects(provider.verifyIdToken(token({ ...baseClaims('n-1'), aud: 'someone-else' }), { nonce: 'n-1' }), /refused/, 'audience');
  await assert.rejects(provider.verifyIdToken(good, { nonce: 'a-different-nonce' }), /refused/, 'nonce');
  await assert.rejects(provider.verifyIdToken(good, {}), /refused/, 'no nonce supplied');
  await assert.rejects(provider.verifyIdToken(`${b64({ alg: 'none', kid: 'rsa-1' })}.${b64(baseClaims('n-1'))}.`, { nonce: 'n-1' }), /refused/, 'alg none');
  await assert.rejects(provider.verifyIdToken(token(baseClaims('n-1'), { alg: 'ES256', kid: 'rsa-1', key: ec.privateKey }), { nonce: 'n-1' }), /refused/, 'ES256 against an RSA key id');
});
