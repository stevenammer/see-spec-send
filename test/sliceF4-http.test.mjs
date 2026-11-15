import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { researchRecord } from '../research/connectors.js';

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



test('F4 fork API binds historical versions, retries once, and refuses arbitrary artifact hashes', async () => {
  const store = new Store(), auth = new Auth(store), password = 'only-fixture-long-password-9';
  for (const id of ['op', 'member', 'leader']) await auth.createUser(id, password, id === 'leader');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const boundCall = (handler, method, path, input, headers = {}) => {
    const match = path.match(/^\/api\/items\/([^/]+)\//);
    const active = match ? store.read(match[1]).context.activePost : null;
    return call(handler, method, path, input, { ...headers, ...(active ? { 'x-post-id': active.id, 'x-post-version': active.version } : {}) });
  };
  const login = async id => {
    const result = await boundCall(handler, 'POST', '/api/login', { id, password });
    return { cookie: result.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': result.body.csrf };
  };
  const op = await login('op'), member = await login('member'), leader = await login('leader');
  const id = (await boundCall(handler, 'POST', '/api/items', { original: 'Transfer drops the note.' }, op)).body.id;
  const see = store.read(id).context.seeHash;
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'specced', see_hash: see, must: ['Keep the note'], how_we_know: ['Transfer retains it'], out_of_scope: [] }, op)).status, 201);
  const spec = store.read(id).context.specHash;
  assert.deepEqual(store.events(id).at(-1).scope, { data_sources: [], audiences: [] });
  const sent = await boundCall(handler, 'POST', `/api/items/${id}/send`, { spec_hash: spec }, op);
  await boundCall(handler, 'POST', '/api/stepup', { password }, leader);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'approved', spec_hash: spec, packet_hash: sent.body.packet_hash,
    reason: 'One synthetic note view is worth testing.', cap_usd: 1, quorum: 1 }, leader)).status, 201);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/steer`, { instruction: 'Connect payroll', scope: { data_sources: ['payroll'], audiences: [] } }, op)).status, 409);
  store.registerToken('fixture-run', { kind: 'run', item: id });
  const artifact = store.putArtifact(id, '<!doctype html><p>Local note</p>');
  store.append(id, { type: 'tried', actor: 'fixture-run', approval: 1, spec_hash: spec, iteration: 0, artifact_hash: artifact, at: new Date().toISOString() }, { idem: 'fixture-try' });
  const tried = store.events(id).at(-1).body_hash;
  const body = { reason: 'Try a smaller note panel.', from: { kind: 'artifact', hash: tried } };
  const headers = { ...member, 'idempotency-key': 'stable-fork-request' };
  const first = await boundCall(handler, 'POST', `/api/items/${id}/fork`, body, headers);
  assert.equal(first.status, 201);
  const child = first.body.id, firstParent = store.events(child)[0].parent;
  assert.equal(store.read(child).state, 'SEEN'); assert.equal(store.read(child).context.specHash, null);
  assert.equal(store.events(child)[0].seed_spec.must[0], 'Keep the note');
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'checked_in', note: 'A later check-in after forking.' }, op)).status, 201);
  const again = await boundCall(handler, 'POST', `/api/items/${id}/fork`, body, headers);
  assert.equal(again.status, 200); assert.equal(again.body.id, child); assert.deepEqual(store.events(child)[0].parent, firstParent);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/fork`, { ...body, reason: 'Different payload same request key.' }, headers)).status, 409);
  for (const hash of [artifact, sent.body.packet_hash]) assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/fork`, { reason: body.reason, from: { kind: 'artifact', hash } }, member)).status, 409);
  assert.equal(store.db.prepare('SELECT count(*) n FROM lineage WHERE parent_item=?').get(id).n, 1);
  const target = new Store(); target.importJsonl(store.exportJsonl());
  assert.ok(target.verifyAll().every(result => result.ok));
  assert.equal(target.artifact(id, artifact), '<!doctype html><p>Local note</p>');
  target.close(); store.close();
});
