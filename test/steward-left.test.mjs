import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

// When a steward leaves the organization, a leader disables their account and can reassign the post at once,
// instead of waiting out fourteen days of inactivity. The basis is recorded on the handoff event itself.

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
  return { status: res.status, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(res.text) : null };
};

async function setup(t) {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store); const password = 'correct-horse-9-battery';
  for (const [id, leader] of [['op', false], ['alex', false], ['leader', true]]) await auth.createUser(id, password, leader);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost', clock: () => Date.parse('2026-11-16T12:00:00Z') });
  const loginHeaders = async id => {
    const req = Readable.from([JSON.stringify({ id, password })]);
    req.method = 'POST'; req.url = '/api/login'; req.headers = { 'content-type': 'application/json' }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = new Response(); await handler(req, res);
    return { cookie: res.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': JSON.parse(res.text).csrf };
  };
  const who = { op: await loginHeaders('op'), leader: await loginHeaders('leader') };
  const made = await call(handler, 'POST', '/api/items', { original: 'The active work loses the caller context.' }, who.op);
  const id = made.body.id;
  const reassign = (input = {}) => {
    const active = store.read(id).context.activePost;
    return call(handler, 'POST', `/api/items/${id}/events`,
      { type: 'steward_changed', steward: 'alex', reason: 'The original steward has left the company.', ...input },
      { ...who.leader, ...(active ? { 'x-post-id': active.id, 'x-post-version': active.version } : {}) });
  };
  return { store, auth, id, reassign };
}

const lastEvent = (store, id) => store.events(id).at(-1);

test('an active steward cannot be replaced early, and a leader cannot claim the steward left', async t => {
  const s = await setup(t);
  assert.equal((await s.reassign()).status, 409, 'no consent, no inactivity, account still enabled');
  assert.equal((await s.reassign({ steward_left: true })).status, 409, 'the client cannot assert the basis itself');
  assert.equal(s.store.read(s.id).context.steward, 'op');
});

test('once a leader disables the steward account, the post can be reassigned at once, and the basis is recorded', async t => {
  const s = await setup(t);
  s.auth.disablePerson('op');
  const result = await s.reassign();
  assert.equal(result.status, 201);
  assert.equal(s.store.read(s.id).context.steward, 'alex');
  const handoff = lastEvent(s.store, s.id);
  assert.equal(handoff.type, 'steward_changed');
  assert.equal(handoff.steward_left, true);
});

test('the store refuses a steward_left handoff while the steward account is enabled, and any value but true', async t => {
  const s = await setup(t);
  let n = 0;
  const put = event => {
    const active = s.store.read(s.id).context.activePost;
    return s.store.append(s.id, { actor: 'leader', at: '2026-11-16T12:00:00Z', post_id: active.id, post_version: active.version, ...event },
      { idem: `left-${n += 1}` });
  };
  const base = { type: 'steward_changed', steward: 'alex', reason: 'The original steward has left the company.' };
  assert.throws(() => put({ ...base, steward_left: true }), /has not left/);
  s.auth.disablePerson('op');
  assert.throws(() => put({ ...base, steward_left: false }), /can only be true/);
  put({ ...base, steward_left: true });
  assert.equal(s.store.read(s.id).context.steward, 'alex');
});

test('an exported handoff made because the steward left imports into a store that has no account state', async t => {
  const s = await setup(t);
  s.auth.disablePerson('op');
  assert.equal((await s.reassign()).status, 201);
  const copy = new Store(); t.after(() => copy.close());
  copy.importJsonl(s.store.exportJsonl());
  assert.equal(copy.read(s.id).context.steward, 'alex');
  assert.equal(copy.events(s.id).at(-1).steward_left, true);
});

test('erasing the handoff note keeps the recorded basis, so the erased history still imports', async t => {
  const s = await setup(t);
  s.auth.disablePerson('op');
  assert.equal((await s.reassign()).status, 201);
  const handoff = s.store.eventRows(s.id).at(-1);
  s.store.erase(s.id, handoff.body_hash, 'leader', '2026-11-16T13:00:00.000Z');
  const kept = s.store.events(s.id).find(event => event.type === 'steward_changed');
  assert.equal(kept.steward_left, true); assert.equal(kept.reason, '[erased note]');
  const copy = new Store(); t.after(() => copy.close());
  copy.importJsonl(s.store.exportJsonl());
  assert.equal(copy.read(s.id).context.steward, 'alex');
});
