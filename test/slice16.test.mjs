import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { itemPage } from '../app/pages.js';
import { initial, step } from '../core/machine.js';

const password = 'correct-horse-9-battery';
class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(key, value) { this.headers[key.toLowerCase()] = value; } writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); } end(value = '') { this.text += value; } }
async function call(handler, method, path, input, headers = {}) { const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path; req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' }; const res = new Response(); await handler(req, res); return { ...res, body: res.text && res.headers['content-type']?.includes('json') ? JSON.parse(res.text) : {} }; }

async function setup() {
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth });
  for (const [id, leader] of [['steward', false], ['lead', true], ['other', true]]) await auth.createUser(id, password, leader);
  const sign = async id => { const login = await call(handler, 'POST', '/api/login', { id, password }); return { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://localhost', 'x-csrf-token': login.body.csrf }; };
  const steward = await sign('steward'); const lead = await sign('lead'); const other = await sign('other');
  const made = await call(handler, 'POST', '/api/items', { problem: 'Visible problem', have: true, have_note: 'looked', verdict: 'build_needed' }, steward);
  const id = made.body.id; const events = `/api/items/${id}/events`;
  const spec = { type: 'specced', must: ['show <this>'], how_we_know: ['check & count'], out_of_scope: ['nothing else'] };
  assert.equal((await call(handler, 'POST', events, spec, steward)).status, 201);
  return { store, auth, handler, id, events, steward, lead, other };
}

test('Decide renders the current escaped spec and approval binds the seen hash and sequence', async () => {
  const { store, handler, id, events, steward, lead } = await setup();
  const before = store.read(id); const seenHash = before.context.specHash; const seenSeq = store.eventRows(id).length;
  const page = await call(handler, 'GET', `/items/${id}`, undefined, lead);
  assert.match(page.text, /show &lt;this&gt;/); assert.match(page.text, /check &amp; count/); assert.match(page.text, /nothing else/);
  assert.match(page.text, new RegExp(`name="spec_hash"[^>]*value="${seenHash}"`));
  assert.match(page.text, new RegExp(`name="expected_seq"[^>]*value="${seenSeq}"`));
  await call(handler, 'POST', events, { type: 'specced', must: ['replacement'], how_we_know: ['new check'], out_of_scope: [] }, steward);
  await call(handler, 'POST', '/api/stepup', { password }, lead);
  const missing = await call(handler, 'POST', events, { type: 'approved', cap_usd: 1, quorum: 1 }, lead);
  assert.equal(missing.status, 409);
  const stale = await call(handler, 'POST', events, { type: 'approved', spec_hash: seenHash, expected_seq: seenSeq, cap_usd: 1, quorum: 1 }, lead);
  assert.equal(stale.status, 409); assert.equal(store.read(id).state, 'SPECCED');
});

test('HTTP event schemas reject unknown, oversized, erased, and forged delivery names without writing', async () => {
  const { store, handler, id, events, lead } = await setup(); const before = store.eventRows(id).length;
  const cases = [
    { type: 'checked_in', note: 'okay', junk: 'x' },
    { type: 'checked_in', note: 'x'.repeat(2001) },
    { type: 'erased', body_hash: 'a'.repeat(64) },
    { type: 'checked_in', note: 'okay', delivered_by: 'lead' },
  ];
  for (const input of cases) assert.equal((await call(handler, 'POST', events, input, lead)).status, 409);
  assert.equal(store.eventRows(id).length, before);
  const state = { id: 'i', state: 'TRYING', context: { steward: 's', approver: 'a', helpers: [], quorum: 1, artifact: 'a'.repeat(64), ineligibleHelpers: [] } };
  const history = itemPage(state, [{ type: 'checked', actor: 's', problem: 'x' }, { type: 'checked_in', actor: 'member', delivered_by: 'lead', note: 'x' }], 'member', false);
  assert.match(history, /member posted a check-in/); assert.doesNotMatch(history, /lead posted a check-in/);
});

test('actor registration preserves kind and account IDs cannot collide or vary by case', async () => {
  const store = new Store(); const auth = new Auth(store); const invite = auth.createInvite('member');
  store.registerSource('source:slack'); store.registerToken('oidc-person', { kind: 'run', item: 'item' });
  for (const id of ['source:slack', 'oidc-person', 'a'.repeat(64), 'bad space', 'Name'])
    await assert.rejects(auth.redeem(invite, id, password), /invalid|unavailable/);
  await auth.createUser('name', password);
  await assert.rejects(auth.createUser('NAME', password), /invalid|exists/);
  assert.throws(() => store.registerPerson('source:slack'), /actor kind/);
  assert.throws(() => store.registerSource('name'), /actor kind/);
  assert.throws(() => store.registerToken('name', { kind: 'run', item: 'item' }), /actor kind/);
});

test('a steward or spec author cannot approve the item', () => {
  const state = { ...initial(), phase: 'SPECCED', steward: 'next', specHash: 'spec', ineligibleHelpers: ['author', 'next'] };
  const approval = actor => ({ type: 'approved', actor, spec_hash: 'spec', cap_usd: 1, quorum: 1 });
  assert.ok(step(state, approval('author'), { kind: 'person', leader: true }).refusal);
  assert.ok(step(state, approval('next'), { kind: 'person', leader: true }).refusal);
  assert.equal(step(state, approval('lead'), { kind: 'person', leader: true }).state, 'SENDING');
});
