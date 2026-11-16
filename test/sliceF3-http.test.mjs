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


test('F3 HTTP decisions bind reviewed packets, preserve history, label estimates, and stamp bounded authority', async () => {
  const store = new Store(); const auth = new Auth(store); const password = 'fixture-only-long-password-9';
  for (const id of ['op', 'member', 'leader']) await auth.createUser(id, password, id === 'leader');
  const now = Date.parse('2026-11-14T23:00:00.000Z');
  const handler = createHandler({ store, auth, clock: () => now, secure: false, origin: 'http://localhost' });
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
  let id = (await boundCall(handler, 'POST', '/api/items', { original: 'Transfer context disappears.' }, op)).body.id;
  const spec = async must => {
    assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'specced', see_hash: store.read(id).context.seeHash,
      must: [must], how_we_know: ['A transfer preserves context'], out_of_scope: [] }, op)).status, 201);
    return store.read(id).context.specHash;
  };
  let hash = await spec('Show the context');
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/research`, {}, member)).status, 409);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/research`, { sources: { 'open source': { status: 'checked' } } }, op)).status, 409);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/research`, {}, op)).status, 201);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'researched', sources: {} }, op)).status, 409);
  const sent = await boundCall(handler, 'POST', `/api/items/${id}/send`, { spec_hash: hash, estimate: 'Two hours, no purchases.' }, op);
  assert.equal(sent.status, 201);
  const packetHash = sent.body.packet_hash;
  const packet = JSON.parse(store.artifact(id, packetHash));
  assert.deepEqual(packet.estimate, { author: 'op', label: 'OP estimate, not independently verified', text: 'Two hours, no purchases.' });
  assert.equal(Object.keys(packet.researched).length, 6);
  assert.ok(Object.values(packet.researched).every(source => source.status === 'not connected' && source.checkedAt === null));
  const reason = 'The existing transfer screen already does this.';
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'not_built', reason, spec_hash: hash, packet_hash: '0'.repeat(64) }, leader)).status, 409);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'not_built', reason, spec_hash: hash, packet_hash: packetHash }, member)).status, 409);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'not_built', reason, spec_hash: hash, packet_hash: packetHash }, leader)).status, 409,
    'rules-3 rejects new legacy generic NO events');
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { type: 'decided', disposition: 'resolve_without_build',
    reason_code: 'existing_view_sufficient', reason, metadata: { alternative: 'Use the existing transfer screen.', action_owner: 'service owner' },
    spec_hash: hash, packet_hash: packetHash }, leader)).status, 201);
  let page = await boundCall(handler, 'GET', `/items/${id}`, null, member);
  assert.equal(page.status, 200); assert.match(page.text, /Two hours, no purchases/); assert.match(page.text, /existing transfer screen/);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/send`, { spec_hash: hash, estimate: 'Two hours, no purchases.' }, op)).status, 409, 'unchanged decided pair cannot be resent');
  const originalId = id;
  const fork = await boundCall(handler, 'POST', `/api/items/${id}/fork`, { reason: 'Explore a separately approved alternative.' }, op);
  assert.equal(fork.status, 201); id = fork.body.id;
  hash = await spec('Carry context into the second transfer too');
  const next = await boundCall(handler, 'POST', `/api/items/${id}/send`, { spec_hash: hash }, op);
  assert.equal(next.status, 201);
  const approval = { type: 'approved', spec_hash: hash, packet_hash: next.body.packet_hash,
    reason: 'New evidence makes a small trial worthwhile.', cap_usd: 1, quorum: 1, max_iterations: 2, window_minutes: 30 };
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, approval, leader)).status, 403);
  assert.equal((await boundCall(handler, 'POST', '/api/stepup', { password }, leader)).status, 204);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, { ...approval, expires_at: '2099-01-01T00:00:00.000Z' }, leader)).status, 409);
  assert.equal((await boundCall(handler, 'POST', `/api/items/${id}/events`, approval, leader)).status, 201);
  assert.equal(store.read(id).context.leash.expiresAt, '2026-11-14T23:30:00.000Z');
  page = await boundCall(handler, 'GET', `/items/${id}`, null, member);
  assert.match(page.text, /small trial worthwhile/);
  const originalPage = await boundCall(handler, 'GET', `/items/${originalId}`, null, member);
  assert.match(originalPage.text, /existing transfer screen/); assert.match(originalPage.text, /Two hours, no purchases/);
  assert.ok(store.verifyAll().every(row => row.ok));
  store.db.close();
});

test('F3 operator research adapters are off by default and failures never become checked results', async () => {
  const at = '2026-11-14T23:00:00.000Z';
  const record = await researchRecord({ at, input: { text: 'workspace problem' }, connectors: {
    'internal prior work': input => `Matched ${input.text}`,
    'open source': () => { throw new Error('private connector details'); },
    'commercial options': () => '',
  } });
  assert.equal(record['internal prior work'].status, 'checked');
  assert.equal(record['internal prior work'].checkedAt, at);
  assert.equal(record['open source'].status, 'failed');
  assert.equal(record['commercial options'].status, 'failed');
  assert.equal(record['process change'].status, 'not connected');
  assert.doesNotMatch(JSON.stringify(record), /private connector details/);
  const store = new Store(); store.registerPerson('op');
  store.append('research', { type: 'posted', actor: 'op', rules: 2, original: 'Original', at }, { idem: 'post' });
  store.append('research', { type: 'researched', actor: 'op', sources: record, at }, { idem: 'research' });
  const hash = store.events('research').at(-1).body_hash;
  store.erase('research', hash, 'op', at);
  assert.equal(store.events('research').find(event => event.type === 'researched').sources['internal prior work'].finding, '[erased]');
  assert.deepEqual(store.verifyAll(), [{ item: 'research', ok: true }]);
  store.db.close();
});

test('F3 fork originals are protected and erasing a handoff note preserves replay', () => {
  const store = new Store();
  for (const id of ['op', 'member', 'leader']) store.registerPerson(id, { leader: id === 'leader' });
  const at = '2026-11-14T12:00:00.000Z'; let n = 0;
  const append = (item, event) => store.append(item, { ...event, at }, { idem: `erase:${++n}` });
  append('parent', { type: 'posted', actor: 'op', rules: 2, original: 'Transfer drops context.' });
  const row = store.eventRows('parent').at(-1);
  append('child', { type: 'forked', actor: 'member', rules: 2, original: 'A fork of this problem.', reason: 'Try a smaller view.', parent: { item: 'parent', seq: row.seq, hash: row.hash } });
  assert.throws(() => store.erase('child', store.events('child')[0].body_hash, 'member', at), /original SEEs/);
  append('parent', { type: 'checked_in', actor: 'op', note: 'I consent to a new steward.', consent: true });
  append('parent', { type: 'steward_changed', actor: 'leader', steward: 'member', reason: 'The original steward is moving teams.' });
  const handoff = store.events('parent').at(-1).body_hash;
  store.erase('parent', handoff, 'leader', at);
  append('parent', { type: 'checked_in', actor: 'member', note: 'The handoff remains valid.' });
  assert.deepEqual(store.verifyAll(), [{ item: 'child', ok: true }, { item: 'parent', ok: true }]);
  store.close();
});
