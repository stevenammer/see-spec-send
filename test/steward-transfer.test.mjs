import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

const DAY = 86_400_000;
class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}
const call = async (handler, method, path, input = null, headers = {}) => {
  const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path; req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, headers: res.headers, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(res.text) : null };
};

async function setup(t) {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store); const password = 'correct-horse-9-battery';
  for (const [id, leader] of [['op', false], ['alex', false], ['sam', false], ['leader', true]]) await auth.createUser(id, password, leader);
  let now = Date.parse('2026-11-16T12:00:00Z');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost', clock: () => now });
  const login = async id => {
    const result = await call(handler, 'POST', '/api/login', { id, password });
    return { cookie: result.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': result.body.csrf };
  };
  const who = Object.fromEntries(await Promise.all(['op', 'alex', 'sam', 'leader'].map(async id => [id, await login(id)])));
  const made = await call(handler, 'POST', '/api/items', { original: 'The active work loses the caller context.' }, who.op);
  const id = made.body.id;
  const bound = (method, path, input, headers) => {
    const active = store.read(id).context.activePost;
    return call(handler, method, path, input, { ...headers, ...(active ? { 'x-post-id': active.id, 'x-post-version': active.version } : {}) });
  };
  const alternative = () => bound('POST', `/api/items/${id}/events`, { type: 'commented', kind: 'alternative',
    comment: 'Use the CRM screen instead.', anchor_kind: 'see', anchor_hash: store.read(id).context.seeHash }, who.alex);
  return { store, handler, id, who, bound, alternative, advance: ms => { now += ms; } };
}

const request = s => s.bound('POST', `/api/items/${s.id}/reconciliation/transfer-request`, { reason: 'The unresolved alternative needs someone to continue it.' }, s.who.alex);

test('transfer is ineligible before fourteen days and exposes its date', async t => {
  const s = await setup(t); await s.alternative(); s.advance(13 * DAY);
  const status = await s.bound('GET', `/api/items/${s.id}/reconciliation`, null, s.who.alex);
  assert.equal(status.body.transfer.inactive, false);
  assert.equal(status.body.transfer.eligible_at, '2026-11-30T12:00:00.000Z');
  assert.equal((await request(s)).status, 409);
});

test('a steward event on the active stage resets transfer inactivity', async t => {
  const s = await setup(t); await s.alternative(); s.advance(13 * DAY);
  const see = s.store.read(s.id).context.seeHash;
  assert.equal((await s.bound('POST', `/api/items/${s.id}/events`, { type: 'revised', text: 'The active work keeps the caller context.', base_hash: see }, s.who.op)).status, 201);
  s.advance(DAY + 1);
  const status = await s.bound('GET', `/api/items/${s.id}/reconciliation`, null, s.who.alex);
  assert.equal(status.body.contributions[0].status, 'unresolved_after_window');
  assert.equal(status.body.transfer.inactive, false);
  assert.equal((await request(s)).status, 409);
  s.advance(13 * DAY);
  assert.equal((await request(s)).status, 201);
});

test('eligible request is visible but only a leader transfers and preserves original credit', async t => {
  const s = await setup(t); await s.alternative(); s.advance(14 * DAY);
  const filed = await request(s); assert.equal(filed.status, 201);
  const record = s.store.events(s.id).at(-1);
  assert.equal(record.type, 'commented'); assert.equal(record.kind, 'transfer_request');
  assert.match(record.comment, /^Transfer requested:/);
  const before = s.store.read(s.id).context;
  assert.equal((await s.bound('POST', `/api/items/${s.id}/events`, { type: 'steward_changed', steward: 'alex', reason: 'The steward has been inactive and Alex requested continuation.' }, s.who.alex)).status, 409);
  assert.equal((await s.bound('POST', `/api/items/${s.id}/events`, { type: 'steward_changed', steward: 'alex', reason: 'The steward has been inactive and Alex requested continuation.' }, s.who.leader)).status, 201);
  const after = s.store.read(s.id).context;
  assert.equal(after.steward, 'alex'); assert.equal(after.originator, 'op');
  assert.ok(after.authors.includes('op')); assert.notEqual(before.steward, after.steward);
});

test('transfer invalidates active approval instead of inheriting it', t => {
  const store = new Store(); t.after(() => store.close());
  for (const id of ['op', 'alex']) store.registerPerson(id); store.registerPerson('leader', { leader: true });
  const at = n => `2026-11-${String(n).padStart(2, '0')}T12:00:00.000Z`;
  const put = (event, n) => store.append('item', { ...event, at: at(n) }, { idem: `transfer:${n}` });
  put({ type: 'posted', actor: 'op', original: 'Keep the caller context.', rules: 3 }, 1);
  let active = store.read('item').context.activePost;
  put({ type: 'specced', actor: 'op', see_hash: active.version, must: ['Keep context'], how_we_know: ['Read it'], out_of_scope: [], post_id: active.id, post_version: active.version }, 2);
  active = store.read('item').context.activePost;
  const packet = store.putArtifact('item', JSON.stringify({ specHash: active.version }));
  put({ type: 'sent', actor: 'op', spec_hash: active.version, packet_hash: packet, post_id: active.id, post_version: active.version }, 3);
  active = store.read('item').context.activePost;
  put({ type: 'approved', actor: 'leader', spec_hash: store.read('item').context.specHash, packet_hash: packet, reason: 'A bounded and reviewed continuation is ready.', cap_usd: 1, quorum: 1, post_id: active.id, post_version: active.version }, 4);
  const approved = store.read('item').context; assert.equal(approved.phase, 'SENDING');
  active = approved.activePost;
  put({ type: 'steward_changed', actor: 'leader', steward: 'alex', reason: 'The active-stage steward has been inactive for fourteen days.', post_id: active.id, post_version: active.version }, 18);
  const transferred = store.read('item').context;
  assert.equal(transferred.phase, 'SPECCED'); assert.equal(transferred.capMicros, null); assert.equal(transferred.sent, null);
  assert.equal(transferred.approval, approved.approval + 1, 'approval fence changes so old authorization cannot be reused');
});

test('stale and forged transfer requests are refused', async t => {
  const s = await setup(t); await s.alternative(); s.advance(14 * DAY);
  const active = s.store.read(s.id).context.activePost;
  const stale = await call(s.handler, 'POST', `/api/items/${s.id}/reconciliation/transfer-request`, { reason: 'Continue the unresolved work.' },
    { ...s.who.alex, 'x-post-id': active.id, 'x-post-version': '0'.repeat(64) });
  assert.equal(stale.status, 409);
  const forged = await s.bound('POST', `/api/items/${s.id}/reconciliation/transfer-request`, { reason: 'Continue the unresolved work.' }, s.who.sam);
  assert.equal(forged.status, 409);
  const generic = await s.bound('POST', `/api/items/${s.id}/events`, { type: 'commented', kind: 'transfer_request', comment: 'forged', anchor_kind: 'see', anchor_hash: s.store.read(s.id).context.seeHash }, s.who.sam);
  assert.equal(generic.status, 409);
});
