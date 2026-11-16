import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { reconciliation, forkEligibility, RECONCILE_DAYS } from '../core/reconcile.js';

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}
const call = async (handler, method, path, input = null, headers = {}) => {
  const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path;
  req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, headers: res.headers, text: res.text,
    body: res.headers['content-type']?.includes('application/json') ? JSON.parse(res.text) : null };
};
const DAY = 86_400_000;

async function setup(t) {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store); const password = 'correct-horse-9-battery';
  for (const [id, leader] of [['op', false], ['alex', false], ['sam', false], ['leader', true]]) await auth.createUser(id, password, leader);
  let now = Date.parse('2026-11-16T12:00:00Z');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost', clock: () => now });
  const bound = (method, path, input, headers = {}) => {
    const match = path.match(/^\/api\/items\/([^/]+)\//);
    const active = match ? store.read(match[1]).context.activePost : null;
    return call(handler, method, path, input, { ...headers, ...(active ? { 'x-post-id': active.id, 'x-post-version': active.version } : {}) });
  };
  const login = async id => {
    const result = await bound('POST', '/api/login', { id, password });
    return { cookie: result.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': result.body.csrf };
  };
  const who = { op: await login('op'), alex: await login('alex'), sam: await login('sam'), leader: await login('leader') };
  const id = (await bound('POST', '/api/items', { original: 'Transfer drops the caller note.' }, who.op)).body.id;
  return { store, bound, who, id, advance: ms => { now += ms; }, clock: () => now };
}
const alternative = (s, person, text = 'Fix it in the CRM screen instead.') => s.bound('POST', `/api/items/${s.id}/events`,
  { type: 'commented', comment: text, kind: 'alternative', anchor_kind: 'see', anchor_hash: s.store.read(s.id).context.seeHash }, s.who[person]);
const fork = (s, person, extra = {}) => s.bound('POST', `/api/items/${s.id}/fork`, { reason: 'We disagree about where to fix this.', ...extra },
  { ...s.who[person], 'idempotency-key': `k-${person}-${Math.random()}` });

test('a fork needs a disagreement: a plain member with no alternative is refused', async t => {
  const s = await setup(t);
  const refusal = await fork(s, 'alex');
  assert.equal(refusal.status, 409);
  assert.match(refusal.body.reason, /needs a disagreement/);
});

test('the steward may still branch their own work', async t => {
  const s = await setup(t);
  assert.equal((await fork(s, 'op')).status, 201);
});

test('an alternative inside the 14-day window cannot fork yet, and says when', async t => {
  const s = await setup(t);
  assert.equal((await alternative(s, 'alex')).status, 201);
  s.advance(13 * DAY);
  const early = await fork(s, 'alex');
  assert.equal(early.status, 409);
  assert.match(early.body.reason, /reconciliation window/);
  assert.equal(early.body.not_before, '2026-11-30T12:00:00.000Z');
  const status = await s.bound('GET', `/api/items/${s.id}/reconciliation`, null, s.who.alex);
  assert.equal(status.body.contributions[0].status, 'pending');
  assert.equal(status.body.you.allowed, false);
});

test('after the window an unresolved alternative earns a fork, and it inherits nothing', async t => {
  const s = await setup(t);
  await alternative(s, 'alex');
  s.advance(RECONCILE_DAYS * DAY + 1);
  const made = await fork(s, 'alex');
  assert.equal(made.status, 201);
  const child = s.store.read(made.body.id).context;
  assert.equal(child.steward, 'alex'); assert.equal(child.approval, 0); assert.equal(child.specHash, null);
  // Someone who never contributed still cannot piggyback.
  assert.equal((await fork(s, 'sam')).status, 409);
});

test('an incorporated alternative is agreement, not a reason to fork', async t => {
  const s = await setup(t);
  const posted = await alternative(s, 'alex');
  assert.equal(posted.status, 201);
  const hash = s.store.events(s.id).at(-1).body_hash;
  const see = s.store.read(s.id).context.seeHash;
  assert.equal((await s.bound('POST', `/api/items/${s.id}/events`, { type: 'revised', text: 'Transfer drops the caller note; fix it in the CRM screen.', base_hash: see,
    credits: [{ comment: hash, mode: 'paraphrased' }] }, s.who.op)).status, 201);
  s.advance(30 * DAY);
  const refusal = await fork(s, 'alex');
  assert.equal(refusal.status, 409);
  assert.match(refusal.body.reason, /incorporated/);
});

test('an alternative left unresolved when the stage freezes can fork immediately', async t => {
  const s = await setup(t);
  await alternative(s, 'alex');
  const see = s.store.read(s.id).context.seeHash;
  assert.equal((await s.bound('POST', `/api/items/${s.id}/events`, { type: 'specced', see_hash: see, must: ['Keep the note'], how_we_know: ['Transfer retains it'], out_of_scope: [] }, s.who.op)).status, 201);
  assert.equal(s.store.read(s.id).context.activePost.kind, 'spec');
  s.advance(DAY);
  const made = await fork(s, 'alex');
  assert.equal(made.status, 201);
});

test('the steward cannot veto: the policy is a pure projection and the steward is exempt from their own list', () => {
  const events = [{ type: 'commented', kind: 'alternative', actor: 'op', at: '2026-11-01T00:00:00Z', body_hash: 'a', post_id: 'p' }];
  assert.deepEqual(reconciliation(events, { steward: 'op', now: Date.parse('2026-12-31') }).contributions, []);
  const report = { contributions: [{ actor: 'x', status: 'unresolved_at_freeze', seq: 5, hash: 'h' }] };
  assert.equal(forkEligibility(report, { person: 'x', steward: 'op' }).allowed, true);
  assert.equal(forkEligibility(report, { person: 'y', steward: 'op' }).allowed, false);
});
