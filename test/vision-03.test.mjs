import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

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

test('F1 HTTP journey has server-built send, fork, and steer routes, then exposes the journey pages', async () => {
  const store = new Store(); const auth = new Auth(store); const password = 'correct-horse-9-battery';
  await auth.createUser('op', password, false);
  await auth.createUser('member', password, false);
  await auth.createUser('leader', password, true);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = async id => {
    const result = await call(handler, 'POST', '/api/login', { id, password });
    return { cookie: result.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': result.body.csrf };
  };
  const op = await login('op'); const member = await login('member'); const leader = await login('leader');
  const post = await call(handler, 'POST', '/api/items', { original: 'The handoff loses the caller context.' }, op);
  assert.equal(post.status, 201);
  const id = post.body.id;
  let page = await call(handler, 'GET', `/items/${id}`, null, op);
  assert.equal(page.status, 200);
  assert.match(page.text, /Original/); assert.match(page.text, /Current SEE v1/); assert.match(page.text, /SPEC IT!/);
  const seeHash = store.read(id).context.seeHash;
  const comment = await call(handler, 'POST', `/api/items/${id}/events`, {
    type: 'commented', comment: 'Show the last caller note before transfer.', kind: 'concern', anchor_kind: 'see', anchor_hash: seeHash,
  }, member);
  assert.equal(comment.status, 201);
  page = await call(handler, 'GET', `/items/${id}`, null, op);
  assert.match(page.text, /Include/);
  const spec = await call(handler, 'POST', `/api/items/${id}/events`, {
    type: 'specced', see_hash: seeHash, must: ['Keep caller context'], how_we_know: ['Test a transfer'], out_of_scope: [],
  }, op);
  assert.equal(spec.status, 201);
  page = await call(handler, 'GET', `/items/${id}/spec`, null, op);
  assert.equal(page.status, 200);
  assert.match(page.text, /Spec v1/); assert.match(page.text, /SEND IT!/);
  const forgedPacket = store.putArtifact(id, JSON.stringify({ specHash: store.read(id).context.specHash }));
  assert.equal((await call(handler, 'POST', `/api/items/${id}/events`, {
    type: 'sent', spec_hash: store.read(id).context.specHash, packet_hash: forgedPacket,
  }, op)).status, 409);
  const sent = await call(handler, 'POST', `/api/items/${id}/send`, { spec_hash: store.read(id).context.specHash }, op);
  assert.equal(sent.status, 201);
  const sentEvent = store.events(id).at(-1);
  assert.equal(sentEvent.type, 'sent'); assert.ok(sentEvent.packet_hash);
  page = await call(handler, 'GET', `/items/${id}`, null, leader);
  assert.match(page.text, /Decision packet/); assert.match(page.text, /Reason for your decision/);
  const stepup = await call(handler, 'POST', '/api/stepup', { password }, leader);
  assert.equal(stepup.status, 204);
  const approved = await call(handler, 'POST', `/api/items/${id}/events`, {
    type: 'approved', spec_hash: store.read(id).context.specHash, packet_hash: sentEvent.packet_hash,
    reason: 'The sandbox is small, useful, and independently reviewed.', cap_usd: 1, quorum: 1,
  }, leader);
  assert.equal(approved.status, 201);
  const fork = await call(handler, 'POST', `/api/items/${id}/fork`, { reason: 'Try a different transfer screen.' }, member);
  assert.equal(fork.status, 201);
  assert.equal(store.read(fork.body.id).context.steward, 'member');
  assert.equal(store.read(fork.body.id).context.approval, 0);
  assert.equal(store.read(fork.body.id).context.specHash, null);
  store.registerToken('run-token', { kind: 'run', item: id });
  store.append(id, { type: 'tried', actor: 'run-token', approval: 1, spec_hash: store.read(id).context.specHash,
    artifact_hash: store.putArtifact(id, '<!doctype html><p>Fixture</p>'), iteration: 0, at: new Date().toISOString() }, { idem: 'fixture-try' });
  page = await call(handler, 'GET', `/items/${id}`, null, op);
  assert.match(page.text, /Adopt as builder instruction/);
  const steer = await call(handler, 'POST', `/api/items/${id}/steer`, { instruction: 'Put the caller note above the transfer button.' }, op);
  assert.equal(steer.status, 201);
  page = await call(handler, 'GET', `/items/${id}`, null, op);
  assert.match(page.text, /caller note above the transfer button/);
  assert.equal((await call(handler, 'POST', `/api/items/${id}/events`, { type: 'sent', spec_hash: seeHash }, op)).status, 409);
});
