import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { FakeOidcProvider, OidcLogin } from '../app/oidc.js';
import { createHandler } from '../app/http.js';
import { main as cli } from '../cli.js';

const password = 'correct-horse-9-battery';
const next = 'fresh-passphrase-42-x';
const temp = () => join(mkdtempSync(join(tmpdir(), 'sss-slice18-')), 'db.sqlite');
function setup(clock = () => Date.now()) {
  const store = new Store();
  const auth = new Auth(store, { clock });
  return { store, auth, handler: createHandler({ store, auth, secure: true }) };
}
const runCli = async (file, args) => {
  const lines = [];
  await cli(args, { ...process.env, SSS_DB: file }, line => lines.push(line));
  return lines.join('\n');
};
class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}
async function call(handler, method, path, input, headers = {}) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method;
  req.url = path;
  req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response();
  await handler(req, res);
  return { ...res, body: res.text ? JSON.parse(res.text) : {} };
}
const setCookies = response => Array.isArray(response.headers['set-cookie'])
  ? response.headers['set-cookie'] : [response.headers['set-cookie']];
const namedCookie = (response, name) => setCookies(response)
  .find(value => value.startsWith(`${name}=`)).split(';')[0];
const sessionCookie = response => namedCookie(response, '__Host-sss');
const oidcBinderCookie = response => namedCookie(response, '__Host-sss-oidc');
const authHeaders = (cookie, csrf) => ({ cookie, origin: 'https://localhost', 'x-csrf-token': csrf });
const count = (store, sql, ...values) => store.db.prepare(sql).get(...values).n;

test('disabled people lose sign-in and sessions, and their past events still verify', async () => {
  const file = temp();
  const store = new Store(file);
  const auth = new Auth(store);
  await auth.createUser('leader', password, true);
  await auth.createUser('member', password);
  const member = await auth.login('member', password, 'ip-a');
  store.append('case-1', { type: 'checked', actor: 'member', at: new Date().toISOString(), problem: 'p',
    looked: ['x'], found: [], verdict: 'build_needed' }, { idem: 'm1' });
  await runCli(file, ['person', 'disable', '--id', 'member']);
  assert.equal(auth.session(member.value), null);
  assert.equal(count(store, 'SELECT count(*) AS n FROM sessions WHERE person=?', 'member'), 0);
  await assert.rejects(auth.login('member', password, 'ip-b'), /unavailable/);
  assert.ok(store.verifyAll().every(answer => answer.ok));
  assert.equal(store.events('case-1')[0].actor, 'member');
  assert.match(await runCli(file, ['person', 'list']), /"id":"member","leader":0,"disabled":1/);
  await runCli(file, ['person', 'enable', '--id', 'member']);
  await assert.doesNotReject(auth.login('member', password, 'ip-c'));
  store.close();
});

test('a disabled person has no live session even if a session row survives', async () => {
  const { auth, store } = setup();
  await auth.createUser('member', password);
  const login = await auth.login('member', password, 'ip-a');
  store.db.prepare('INSERT INTO person_state(id,disabled) VALUES(?,1)').run('member');
  assert.equal(auth.session(login.value), null);
  assert.equal(count(store, 'SELECT count(*) AS n FROM sessions WHERE person=?', 'member'), 1);
});

test('a reset code is single-use and forces a new password before anything else', async () => {
  const file = temp();
  const store = new Store(file);
  const auth = new Auth(store);
  const handler = createHandler({ store, auth, secure: true });
  await auth.createUser('leader', password, true);
  await auth.createUser('member', password);
  const before = await auth.login('member', password, 'ip-z');
  const printed = await runCli(file, ['person', 'reset', '--id', 'member']);
  assert.equal(auth.session(before.value), null);
  const code = printed.match(/single-use code: (\S+)/)[1];
  await assert.rejects(auth.login('member', password, 'ip-a'), /unavailable/);
  const login = await call(handler, 'POST', '/api/login', { id: 'member', password: code });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  const headers = authHeaders(cookie, login.body.csrf);
  assert.equal((await call(handler, 'GET', '/api/items', undefined, { cookie })).status, 403);
  assert.equal((await call(handler, 'POST', '/api/password', { password: next }, headers)).status, 400);
  assert.equal((await call(handler, 'POST', '/api/login', { id: 'member', password: code }, {})).status, 400);
  assert.equal((await call(handler, 'POST', '/api/stepup', { password: code }, headers)).status, 204);
  const changed = await call(handler, 'POST', '/api/password', { password: next }, headers);
  assert.equal(changed.status, 200);
  assert.equal((await call(handler, 'GET', '/api/me', undefined, { cookie })).status, 403);
  assert.equal((await call(handler, 'GET', '/api/items', undefined, { cookie: sessionCookie(changed) })).status, 200);
  await assert.doesNotReject(auth.login('member', next, 'ip-b'));
  await assert.rejects(auth.login('member', code, 'ip-c'), /unavailable/);
  store.close();
});

test('the init password must be changed at first sign-in', async () => {
  const file = temp();
  const store = new Store(file);
  const auth = new Auth(store);
  const handler = createHandler({ store, auth, secure: true });
  const printed = (await runCli(file, ['init', '--id', 'root'])).match(/one-time password: (.+)/)[1].trim();
  const login = await call(handler, 'POST', '/api/login', { id: 'root', password: printed });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  const headers = authHeaders(cookie, login.body.csrf);
  assert.equal((await call(handler, 'GET', '/api/items', undefined, { cookie })).status, 403);
  assert.equal((await call(handler, 'POST', '/api/password', { password: next }, headers)).status, 400);
  assert.equal((await call(handler, 'POST', '/api/stepup', { password: printed }, headers)).status, 204);
  const changed = await call(handler, 'POST', '/api/password', { password: next }, headers);
  assert.equal(changed.status, 200);
  assert.equal((await call(handler, 'GET', '/api/items', undefined, { cookie: sessionCookie(changed) })).status, 200);
  await assert.rejects(auth.login('root', printed, 'ip-z'), /unavailable/);
  store.close();
});

test('promote and demote change future authority, keep one enabled leader, and leave past events verifiable', async () => {
  const file = temp();
  const store = new Store(file);
  const auth = new Auth(store);
  await auth.createUser('leader', password, true);
  await auth.createUser('member', password);
  store.append('case-2', { type: 'checked', actor: 'leader', at: new Date().toISOString(), problem: 'p',
    looked: ['x'], found: [], verdict: 'build_needed' }, { idem: 'l1' });
  await runCli(file, ['person', 'promote', '--id', 'member']);
  assert.equal(store.actor('member', '').leader, true);
  await runCli(file, ['person', 'demote', '--id', 'leader']);
  assert.equal(store.actor('leader', '').leader, false);
  await assert.rejects(runCli(file, ['person', 'demote', '--id', 'member']), /at least one enabled leader/);
  await assert.rejects(runCli(file, ['person', 'disable', '--id', 'member']), /at least one enabled leader/);
  assert.equal(store.actor('member', '').leader, true);
  assert.ok(store.verifyAll().every(answer => answer.ok));
  assert.equal(store.eventRows('case-2')[0].actor_leader, 1);
  store.close();
});

test('invites can be listed and revoked by a unique hex prefix, and a revoked invite cannot be redeemed', async () => {
  const file = temp();
  const store = new Store(file);
  const auth = new Auth(store);
  const token = (await runCli(file, ['invite', 'create', '--role', 'member'])).trim();
  const listed = await runCli(file, ['invite', 'list']);
  assert.equal(listed.includes(token), false);
  const row = JSON.parse(listed);
  assert.equal(row.status, 'open');
  assert.match(row.id, /^[a-f0-9]{12}$/);
  await assert.rejects(runCli(file, ['invite', 'revoke', '--id', 'abc']), /at least 12 hex/);
  assert.match(await runCli(file, ['invite', 'revoke', '--id', row.id]), /revoked/);
  assert.equal(JSON.parse(await runCli(file, ['invite', 'list'])).status, 'revoked');
  await assert.rejects(auth.redeem(token, 'late', password, 'ip-q'), /unavailable/);
  assert.equal(count(store, "SELECT count(*) AS n FROM users WHERE id='late'"), 0);
  store.close();
});

test('a signed-in person changes their password only with fresh step-up, and every session ends', async () => {
  const { auth, handler } = setup(() => 6_000_000);
  await auth.createUser('member', password);
  const login = await call(handler, 'POST', '/api/login', { id: 'member', password });
  const cookie = sessionCookie(login);
  const headers = authHeaders(cookie, login.body.csrf);
  assert.equal((await call(handler, 'POST', '/api/password', { password: next }, headers)).status, 400);
  assert.equal((await call(handler, 'POST', '/api/stepup', { password }, headers)).status, 204);
  assert.equal((await call(handler, 'POST', '/api/password', { password: 'password1234' }, headers)).status, 400);
  const changed = await call(handler, 'POST', '/api/password', { password: next }, headers);
  assert.equal(changed.status, 200);
  assert.equal((await call(handler, 'GET', '/api/me', undefined, { cookie })).status, 403);
  const fresh = authHeaders(sessionCookie(changed), changed.body.csrf);
  assert.equal((await call(handler, 'POST', '/api/password', { password: 'another-passphrase-9-z' }, fresh)).status, 400);
  await assert.rejects(auth.login('member', password, 'ip-a'), /unavailable/);
  await assert.doesNotReject(auth.login('member', next, 'ip-b'));
});

test('login does the same KDF work and failure bookkeeping for unknown and known IDs', async () => {
  let time = 3_000_000;
  const { auth, store } = setup(() => time);
  await auth.createUser('known', password, true);
  let kdf = 0;
  const matches = auth.matches.bind(auth);
  const record = auth.passwordRecord.bind(auth);
  auth.matches = async (...args) => { kdf += 1; return matches(...args); };
  auth.passwordRecord = async (...args) => { kdf += 1; return record(...args); };
  const attempt = async id => {
    kdf = 0;
    const error = await auth.login(id, 'wrong-password-9', 'probe-ip').then(() => null, failure => failure);
    return { message: error.message, kdf };
  };
  await assert.rejects(auth.login(undefined, 'wrong-password-9', 'probe-ip'), /unavailable/);
  const unknown = await attempt('nobody-here');
  const wrong = await attempt('known');
  assert.equal(unknown.message, wrong.message);
  assert.equal(unknown.kdf, 1);
  assert.equal(wrong.kdf, 1);
  const rows = account => count(store, 'SELECT count(*) AS n FROM login_failures WHERE account=?', account);
  assert.equal(rows('known'), 1);
  assert.equal(rows('nobody-here'), 1);
  assert.equal(auth.loginBlocked('known', 'probe-ip'), true);
  assert.equal(auth.loginBlocked('nobody-here', 'probe-ip'), true);
  time += 16 * 60_000;
  auth.loginBlocked('known', 'probe-ip');
  assert.equal(rows('known'), 0);
  assert.equal(rows('nobody-here'), 0);
  store.close();
});

test('failure bookkeeping stays bounded under a flood of unknown IDs', async () => {
  const time = 4_000_000;
  const { auth, store } = setup(() => time);
  store.db.exec(`INSERT INTO login_failures(account,ip,at)
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100010)
    SELECT 'flood' || x, 'flood-ip', ${time} FROM c`);
  await assert.rejects(auth.login('one-more', 'wrong-password-9', 'fresh-ip'), /unavailable/);
  assert.ok(count(store, 'SELECT count(*) AS n FROM login_failures') <= 100_000);
  store.close();
});

test('new hashes use scrypt N=2^17, and a legacy N=16384 record is re-hashed on the next good login', async () => {
  const { auth, store } = setup();
  await auth.createUser('fresh', password);
  const fresh = store.db.prepare('SELECT password FROM users WHERE id=?').get('fresh').password;
  assert.match(fresh, /^scrypt\$131072\$8\$1\$/);
  const salt = randomBytes(16).toString('base64url');
  const value = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  store.db.prepare('INSERT INTO users(id,password,leader) VALUES(?,?,0)')
    .run('legacy', `scrypt$16384$8$1$${salt}$${value.toString('base64url')}`);
  store.registerPerson('legacy');
  await assert.rejects(auth.login('legacy', 'wrong-password-9', 'ip-a'), /unavailable/);
  await assert.doesNotReject(auth.login('legacy', password, 'ip-b'));
  const rehashed = store.db.prepare('SELECT password FROM users WHERE id=?').get('legacy').password;
  assert.match(rehashed, /^scrypt\$131072\$8\$1\$/);
  await assert.doesNotReject(auth.login('legacy', password, 'ip-c'));
  store.close();
});

test('the common-password check covers passwords of 12 or more characters', async () => {
  const { auth, store } = setup();
  const weak = ['password1234', 'Iloveyou1234', 'Letmein123456', 'changeme1234'];
  for (const [index, value] of weak.entries()) {
    await assert.rejects(auth.createUser(`weak${index}`, value), /policy/);
  }
  assert.equal(count(store, 'SELECT count(*) AS n FROM users'), 0);
  store.close();
});

test('OIDC sign-in refuses a disabled person', async () => {
  let time = 5_000_000;
  const store = new Store();
  const provider = new FakeOidcProvider({ clock: () => time });
  const oidc = new OidcLogin(provider.configuration('https://localhost/api/oidc/callback'), { clock: () => time });
  const auth = new Auth(store, { clock: () => time, oidc });
  const handler = createHandler({ store, auth, secure: true });
  const signIn = async () => {
    const start = await call(handler, 'GET', '/api/oidc/start');
    const authorize = new URL(start.headers.location);
    const code = provider.issue({ codeChallenge: authorize.searchParams.get('code_challenge'),
      nonce: authorize.searchParams.get('nonce'), subject: 'sso-person' });
    const state = encodeURIComponent(authorize.searchParams.get('state'));
    return call(handler, 'GET', `/api/oidc/callback?state=${state}&code=${encodeURIComponent(code)}`,
      undefined, { cookie: oidcBinderCookie(start) });
  };
  const first = await signIn();
  assert.equal(first.status, 302);
  const me = await call(handler, 'GET', '/api/me', undefined, { cookie: sessionCookie(first) });
  auth.disablePerson(me.body.id);
  assert.equal((await call(handler, 'GET', '/api/me', undefined, { cookie: sessionCookie(first) })).status, 403);
  time += 1000;
  assert.equal((await signIn()).status, 400);
  store.close();
});
