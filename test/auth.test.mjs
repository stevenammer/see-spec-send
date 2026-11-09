import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { main as cli } from '../cli.js';

const password = 'correct-horse-9-battery';
const temp = () => join(mkdtempSync(join(tmpdir(), 'sss-auth-')), 'db.sqlite');
function setup(clock = () => Date.now()) {
  const file = temp();
  const store = new Store(file);
  const auth = new Auth(store, { clock });
  return { store, auth, file, handler: createHandler({ store, auth, secure: true }) };
}
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
const sessionCookie = response => response.headers['set-cookie'].split(';')[0];
const authHeaders = (cookie, csrf) => ({ cookie, origin: 'https://localhost', 'x-csrf-token': csrf });

test('password policy, invites, and no plaintext storage', async () => {
  const { auth, file } = setup();
  await assert.rejects(auth.createUser('bad', 'password'), /policy/);
  const invite = auth.createInvite('member');
  await auth.redeem(invite, 'member', password);
  const bytes = readFileSync(file).toString('latin1');
  assert.equal(bytes.includes(password), false);
  assert.equal(bytes.includes(invite), false);
});

test('parallel invite redemption has exactly one winner, expiry and reuse fail', async () => {
  const { auth } = setup();
  const invite = auth.createInvite('leader');
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    auth.redeem(invite, `p${index}`, password)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(auth.redeem(invite, 'again', password, 'new-ip'), /unavailable|later/);
  const once = auth.createInvite('member');
  await auth.redeem(once, 'one', password, 'one-ip');
  await assert.rejects(auth.redeem(once, 'two', password, 'two-ip'), /unavailable/);
  const expired = auth.createInvite('member', Date.now() - 1);
  await assert.rejects(auth.redeem(expired, 'late', password), /unavailable|later/);
  assert.throws(() => auth.createInvite('admin'), /role/);
});

test('login rate limit, lockout, no enumeration, expiry and revocation', async () => {
  let time = 1_000_000;
  const { auth } = setup(() => time);
  await auth.createUser('known', password, true);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(auth.allowed('bucket-ip', 'bucket-user'), true);
  }
  assert.equal(auth.allowed('bucket-ip', 'bucket-user'), false);
  const unknown = await assert.rejects(auth.login('unknown', password), /unavailable/);
  const wrong = await assert.rejects(auth.login('known', 'wrong-password-9'), /unavailable/);
  assert.equal(unknown?.message, wrong?.message);
  // The failing address is locked out for a moment, even with the right password.
  await assert.rejects(auth.login('known', password), /unavailable/);
  time += 61 * 60_000;
  const first = await auth.login('known', password, 'different-ip');
  assert.ok(auth.session(first.value));
  auth.revokePerson('known');
  assert.equal(auth.session(first.value), null);
  const second = await auth.login('known', password, 'third-ip');
  time += 31 * 60_000;
  assert.equal(auth.session(second.value), null);
});

test('handler protects CSRF, cookies, parser input, and fixation', async () => {
  const { auth, handler } = setup();
  await auth.createUser('leader', password, true);
  const login = await call(handler, 'POST', '/api/login', { id: 'leader', password });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'], /__Host-sss=.*HttpOnly.*SameSite=Strict.*Secure/);
  assert.equal(login.headers['content-security-policy'].includes("'none'"), true);
  const cookie = sessionCookie(login);
  const me = await call(handler, 'GET', '/api/me', undefined, { cookie });
  assert.equal(me.status, 200);
  const missing = await call(handler, 'POST', '/api/logout', {}, { cookie });
  assert.equal(missing.status, 403);
  const noToken = await call(handler, 'POST', '/api/logout', {}, {
    cookie, origin: 'https://localhost',
  });
  assert.equal(noToken.status, 403);
  const cross = await call(handler, 'POST', '/api/logout', {}, { cookie, origin: 'https://evil.test', 'x-csrf-token': me.body.csrf });
  assert.equal(cross.status, 403);
  for (const lookalike of ['https://localhost.evil.test', 'https://localhost:8443', 'http://localhost', 'https://localhost' + '@evil.test']) {
    const fake = await call(handler, 'POST', '/api/logout', {}, { cookie, origin: lookalike, 'x-csrf-token': me.body.csrf });
    assert.equal(fake.status, 403, `lookalike origin ${lookalike} must be refused`);
    const fakeReferer = await call(handler, 'POST', '/api/logout', {}, { cookie, referer: lookalike + '/page', 'x-csrf-token': me.body.csrf });
    assert.equal(fakeReferer.status, 403, `lookalike referer ${lookalike} must be refused`);
  }
  const malformed = await call(handler, 'POST', '/api/login', '{bad', { 'content-type': 'application/json' });
  assert.equal(malformed.status, 400);
  const polluted = await call(handler, 'POST', '/api/login', { __proto__: { bad: true } });
  assert.equal(polluted.status, 400);
  const huge = await call(handler, 'POST', '/api/login', { id: 'a'.repeat(17_000), password });
  assert.equal(huge.status, 400);
  const later = await call(handler, 'POST', '/api/login', { id: 'leader', password }, { 'x-forwarded-for': 'ignored' });
  assert.notEqual(sessionCookie(later), cookie);
  assert.equal((await call(handler, 'GET', '/api/me', undefined, { cookie })).status, 403);
});

test('step-up proof has one use', async () => {
  const { auth } = setup();
  await auth.createUser('leader', password, true);
  const login = await auth.login('leader', password, 'new-ip');
  await auth.stepup(login.value, password, 'new-ip');
  assert.equal(auth.useStepup(login.value), true);
  assert.equal(auth.useStepup(login.value), false);
});

test('events reject client authority, tokens, self approval, and require fresh single-use step-up', async () => {
  let time = 2_000_000;
  const { auth, handler } = setup(() => time);
  await auth.createUser('leader', password, true);
  await auth.createUser('member', password);
  const login = await call(handler, 'POST', '/api/login', { id: 'leader', password });
  const cookie = sessionCookie(login);
  const me = login.body;
  const send = input => call(handler, 'POST', '/api/items/a/events', input, authHeaders(cookie, me.csrf));
  assert.equal((await send({ type: 'checked', actor: 'member', looked: ['x'], found: [], verdict: 'build_needed' })).status, 403);
  assert.equal((await send({ type: 'checked', role: 'leader', looked: ['x'], found: [], verdict: 'build_needed' })).status, 403);
  assert.equal((await send({ type: 'checked', looked: ['x'], found: [], verdict: 'build_needed' })).status, 201);
  assert.equal((await send({ type: 'specced', must: ['x'], how_we_know: ['x'], out_of_scope: [] })).status, 201);
  const before = await send({ type: 'approved', spec_hash: 'x', cap_usd: 1, quorum: 1 });
  assert.equal(before.status, 403);
  assert.equal((await call(handler, 'POST', '/api/stepup', { password }, authHeaders(cookie, me.csrf))).status, 204);
  const self = await send({ type: 'approved', spec_hash: 'x', cap_usd: 1, quorum: 1 });
  assert.equal(self.status, 409);
  time += 6 * 60_000;
  assert.equal((await send({ type: 'approved', spec_hash: 'x', cap_usd: 1, quorum: 1 })).status, 403);
  assert.equal((await send({ type: 'charged', usd: 1, actor: 'gateway' })).status, 403);
});

test('cli creates hashed secrets and runs commands end to end', () => {
  const db = temp();
  const run = async args => {
    const lines = [];
    await cli(args, { ...process.env, SSS_DB: db }, line => lines.push(line));
    return lines.join('\n');
  };
  return (async () => {
  const init = await run(['init', '--id', 'root']);
  const printed = init.match(/one-time password: (.+)/)[1].trim();
  const invite = await run(['invite', 'create', '--role', 'member']);
  const api = await run(['token', 'create', '--kind', 'run', '--item', 'a']);
  const bytes = readFileSync(db).toString('latin1');
  assert.equal(bytes.includes(printed) || bytes.includes(invite) || bytes.includes(api), false);
  assert.match(await run(['person', 'list']), /root/);
  await run(['verify']);
  await run(['backup', '--to', `${db}.copy`]);
  })();
});
