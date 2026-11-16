import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

// Hostile and malformed input to every route must never produce a server error or crash the process.
// A fixed seed makes failures reproducible; raise FUZZ_ROUNDS locally to dig deeper.
let seed = Number(process.env.FUZZ_SEED || 20261116);
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(rand() * list.length)];
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const junkString = () => pick(['', 'x', '<script>alert(1)</script>', '../../etc/passwd', '\u0000', '\ud800', 'a'.repeat(5000), '{"a":1}', '${7*7}', "' OR 1=1 --", '%00', 'ünïcödé', hex(64), 'constructor', '__proto__', '\n\r\n']);
const junkValue = (depth = 0) => {
  const kinds = [() => null, () => true, () => false, () => Math.floor(rand() * 2 ** 31), () => -1, () => 1.5, () => NaN, () => Infinity, junkString, () => [], () => ({})];
  if (depth < 3) kinds.push(() => Array.from({ length: Math.floor(rand() * 4) }, () => junkValue(depth + 1)), () => Object.fromEntries(Array.from({ length: Math.floor(rand() * 5) }, () => [junkString().slice(0, 20) || 'k', junkValue(depth + 1)])));
  return pick(kinds)();
};
const knownKeys = ['type', 'original', 'comment', 'kind', 'anchor_kind', 'anchor_hash', 'parent', 'reason', 'spec_hash', 'packet_hash', 'must', 'how_we_know', 'out_of_scope', 'assumptions', 'open_questions',
  'ledger', 'estimates', 'credits', 'text', 'base_hash', 'from', 'note', 'annex', 'what_is_new', 'question', 'objectives', 'constraints', 'items', 'to', 'password', 'id', 'invite', 'instruction', 'source', 'mode', 'scope', 'cap_usd', 'quorum'];
const fuzzBody = () => Object.fromEntries(Array.from({ length: 1 + Math.floor(rand() * 7) }, () => [pick(knownKeys), junkValue()]));

class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } write(v) { this.text += v; } }
async function call(handler, method, path, body, headers = {}) {
  const raw = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  const req = Readable.from(raw); req.method = method; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { ...(raw.length ? { 'content-type': 'application/json', origin: 'http://localhost' } : {}), ...headers };
  const res = new Res(); await handler(req, res); return res;
}

test('fuzz: no route answers hostile input with a server error, and every answer is well formed', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('fuzzer', 'a-long-fuzz-passphrase-9x', false); await auth.createUser('boss', 'a-long-fuzz-passphrase-9x', true);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = await auth.login('fuzzer', 'a-long-fuzz-passphrase-9x', '127.0.0.1');
  const session = { cookie: `sss=${login.value}`, 'x-csrf-token': login.csrf, origin: 'http://localhost' };
  const made = await call(handler, 'POST', '/api/items', { original: 'A real item for the fuzzer to poke at.' }, session);
  const item = JSON.parse(made.text).id; assert.ok(item);
  const routes = [
    ['POST', '/api/items'], ['POST', `/api/items/${item}/events`], ['POST', `/api/items/${item}/send`], ['POST', `/api/items/${item}/fork`], ['POST', `/api/items/${item}/renew`], ['POST', `/api/items/${item}/steer`],
    ['POST', `/api/items/${item}/erase`], ['POST', `/api/items/${item}/spec-draft`], ['POST', `/api/items/${item}/artifact`], ['POST', `/api/annexes/${hex(64)}/response`], ['POST', `/api/knowledge/${hex(64)}/correction`],
    ['POST', '/api/intelligence/package'], ['POST', '/api/intelligence/review'], ['POST', '/api/intelligence/run'], ['POST', `/api/intelligence/receipts/${hex(64)}`], ['POST', '/api/mentoring/optin'], ['POST', '/api/mentoring/requests'],
    ['POST', '/api/password'], ['POST', '/api/stepup'], ['POST', '/api/invite/redeem'], ['POST', '/api/login'], ['POST', '/api/quest/model/draft'],
    ['GET', `/api/items/${item}`], ['GET', `/api/items/${item}/updates`], ['GET', `/api/items/${item}/reconciliation`], ['GET', '/api/digest'], ['GET', '/knowledge?q=%00%ff'], ['GET', '/search?q=' + encodeURIComponent('"* OR ( NEAR(')], ['GET', `/items/${item}/related`], ['GET', `/items/${item}/spec`], ['GET', `/items/${item}`],
    ['GET', '/items/' + encodeURIComponent('../../x')], ['GET', '/api/intelligence/receipts/' + hex(64)], ['GET', '/assets/../core/store.js'], ['GET', '/assets/%2e%2e/cli.js'],
  ];
  const rounds = Number(process.env.FUZZ_ROUNDS || 12); const failures = [];
  for (let round = 0; round < rounds; round += 1) for (const [method, path] of routes) {
    const body = method === 'POST' ? (rand() < 0.1 ? junkString() : fuzzBody()) : undefined;
    const res = await call(handler, method, path, body, rand() < 0.15 ? {} : session).catch(error => ({ status: 'THROW', text: error.message }));
    if (res.status === 'THROW' || res.status >= 500) failures.push(`${method} ${path} -> ${res.status} ${String(res.text).slice(0, 80)} body=${JSON.stringify(body)?.slice(0, 120)}`);
    else if (!Number.isInteger(res.status)) failures.push(`${method} ${path} produced no status`);
    else if (res.status < 400 && method === 'GET' && !res.headers['content-type']) failures.push(`${method} ${path} -> ${res.status} without a content type`);
  }
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} bad answers; first few shown`);
  assert.ok(store.verifyAll().every(row => row.ok), 'the fuzzed store still verifies');
  assert.ok(store.knowledge.verify().ok);
});

test('fuzz: oversized, truncated and non-JSON bodies are refused without a server error', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('fuzzer', 'a-long-fuzz-passphrase-9x', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = await auth.login('fuzzer', 'a-long-fuzz-passphrase-9x', '127.0.0.1');
  const session = { cookie: `sss=${login.value}`, 'x-csrf-token': login.csrf, origin: 'http://localhost' };
  for (const body of ['{', '[', 'null', '"str"', '12', '{"original":', 'x'.repeat(3_000_000), '{"original":"' + 'y'.repeat(2_000_000) + '"}', '\u0000\u0001', '{"__proto__":{"admin":true}}', '{"constructor":{"prototype":{"x":1}}}']) {
    const res = await call(handler, 'POST', '/api/items', body, session);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body.slice(0, 20))} -> ${res.status}`);
  }
  assert.equal({}.admin, undefined, 'the prototype was not polluted');
});

test('fuzz: starting from valid requests and corrupting one field at a time never causes a server error', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('fuzzer', 'a-long-fuzz-passphrase-9x', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = await auth.login('fuzzer', 'a-long-fuzz-passphrase-9x', '127.0.0.1');
  const session = { cookie: `sss=${login.value}`, 'x-csrf-token': login.csrf, origin: 'http://localhost' };
  const made = await call(handler, 'POST', '/api/items', { original: 'The handoff loses the caller note.' }, session); const item = JSON.parse(made.text).id;
  const state = () => store.read(item).context;
  const valid = () => [
    ['POST', `/api/items/${item}/events`, { type: 'commented', comment: 'A point.', kind: 'alternative', anchor_kind: 'see', anchor_hash: state().seeHash }],
    ['POST', `/api/items/${item}/events`, { type: 'revised', text: 'The handoff loses the caller note.', base_hash: state().seeHash, credits: [] }],
    ['POST', `/api/items/${item}/events`, { type: 'specced', see_hash: state().seeHash, must: ['Keep it'], how_we_know: ['It shows'], out_of_scope: [], assumptions: ['A new integration is needed.'], open_questions: ['Who owns it?'], estimates: [{ dimension: 'people_time', low: 1, high: 2, unit: 'days', basis: [], unknowns: [], alternatives: [] }] }],
    ['POST', `/api/items/${item}/fork`, { reason: 'We disagree.' }], ['POST', `/api/items/${item}/renew`, { annex: 'a'.repeat(64), what_is_new: 'New.', reason: 'Because.' }],
    ['POST', '/api/intelligence/run', { question: 'Which decisions mention a budget?', objectives: ['Understand.'], constraints: ['Be fair.'], items: [item], from: '2026-11-16T00:00:00.000Z', to: '2026-11-16T23:59:59.000Z' }],
    ['POST', `/api/annexes/${'b'.repeat(64)}/response`, { kind: 'relevant' }], ['POST', `/api/knowledge/${'c'.repeat(64)}/correction`, { note: 'Context.' }],
  ];
  const failures = []; const rounds = Number(process.env.FUZZ_ROUNDS || 12);
  for (let round = 0; round < rounds; round += 1) for (const [method, path, template] of valid()) {
    const keys = Object.keys(template); const mutated = { ...template }; const key = pick(keys);
    if (rand() < 0.2) delete mutated[key]; else mutated[key] = junkValue();
    const res = await call(handler, method, path, mutated, session).catch(error => ({ status: 'THROW', text: error.message }));
    if (res.status === 'THROW' || res.status >= 500) failures.push(`${path} mutate ${key} -> ${res.status} ${String(res.text).slice(0, 70)} value=${JSON.stringify(mutated[key])?.slice(0, 80)}`);
  }
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} server errors; first few shown`);
  assert.ok(store.verify(item).ok);
});

test('regressions found by fuzzing: null and array bodies, a missing password, a malformed analysis request, and an invite redeem with missing fields are refusals, not server errors', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('fuzzer', 'a-long-fuzz-passphrase-9x', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = await auth.login('fuzzer', 'a-long-fuzz-passphrase-9x', '127.0.0.1');
  const session = { cookie: `sss=${login.value}`, 'x-csrf-token': login.csrf, origin: 'http://localhost' };
  const expect4xx = async (label, method, path, body, headers = session) => { const res = await call(handler, method, path, body, headers); assert.ok(res.status >= 400 && res.status < 500, `${label} -> ${res.status}`); };
  for (const body of ['null', '[]', '[{"original":"x"}]', '"text"', '7', 'true']) await expect4xx(`body ${body} on /api/items`, 'POST', '/api/items', body);
  await expect4xx('step-up with no password', 'POST', '/api/stepup', {});
  await expect4xx('step-up with a non-text password', 'POST', '/api/stepup', { password: 12 });
  await expect4xx('analysis with objectives that are not a list', 'POST', '/api/intelligence/run', { question: 'Which?', objectives: -1, constraints: [], items: [], from: 'x', to: 'y' });
  await expect4xx('analysis with a non-text question', 'POST', '/api/intelligence/run', { question: ['a'], objectives: [], constraints: [], items: ['x'], from: 'x', to: 'y' });
  await expect4xx('redeem with no invite and no password', 'POST', '/api/invite/redeem', { id: 'constructor' }, { origin: 'http://localhost' });
  await expect4xx('redeem with numbers', 'POST', '/api/invite/redeem', { invite: 5, id: 'someone-new', password: 9 }, { origin: 'http://localhost' });
  assert.equal({}.admin, undefined);
});
