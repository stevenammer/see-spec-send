import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Integrations, hmac } from '../app/integrations.js';

// Findings from running Cloudflare's open-source security-audit skill against this repo (Nov 17, 2026), each one
// checked by hand against the source before it was fixed. The audit was source-only; these tests are the execution.
class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}
async function call(handler, method, path, headers = {}, input = null) {
  const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path; req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, text: res.text, headers: res.headers };
}
async function world(t) {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  for (const id of ['sam', 'riya', 'pat']) await auth.createUser(id, `${id}-long-password-9x`, false);
  store.groupCreate('Reservations', 'night shift'); store.groupAdd('Reservations', 'sam'); store.groupAdd('Reservations', 'riya');
  store.append('secret', { type: 'posted', actor: 'sam', rules: 3, original: 'Private export problem for reservations only', audience: ['Reservations'], at: '2026-11-17T12:00:00.000Z' }, { idem: 'p' });
  store.append('open', { type: 'posted', actor: 'sam', rules: 3, original: 'An open workspace problem', audience: [], at: '2026-11-17T12:01:00.000Z' }, { idem: 'o' });
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const as = async id => {
    const login = await call(handler, 'POST', '/api/login', {}, { id, password: `${id}-long-password-9x` });
    return { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': JSON.parse(login.text).csrf };
  };
  return { store, handler, as };
}

test('the reconciliation report and transfer request follow the read scope like every other route', async t => {
  const { handler, as } = await world(t);
  const pat = await as('pat'), riya = await as('riya');
  assert.equal((await call(handler, 'GET', '/api/items/secret/reconciliation', pat)).status, 403, 'an outsider learns nothing, not even who the steward is');
  assert.equal((await call(handler, 'POST', '/api/items/secret/reconciliation/transfer-request', pat, { reason: 'I would like this one' })).status, 403);
  assert.equal((await call(handler, 'GET', '/api/items/secret/reconciliation', riya)).status, 200, 'a member of the audience still sees it');
  assert.equal((await call(handler, 'GET', '/api/items/open/reconciliation', pat)).status, 200, 'an unrestricted item is unchanged');
});

test('a restricted item cannot be forked into a workspace-wide copy', async t => {
  const { handler, store, as } = await world(t);
  const pat = await as('pat'), riya = await as('riya');
  const before = store.listItems().length;
  assert.equal((await call(handler, 'POST', '/api/items/secret/fork', pat, { reason: 'I want my own copy of this' })).status, 403, 'an outsider is refused');
  const insider = await call(handler, 'POST', '/api/items/secret/fork', riya, { reason: 'I want my own copy of this' });
  assert.equal(insider.status, 409, 'even a member is refused until a fork can keep the audience');
  assert.match(insider.text, /restricted items cannot be forked yet/);
  assert.equal(store.listItems().length, before, 'no copy of the private text was created');
});

test('a person’s contribution record leaves out work in groups the viewer is not in', async t => {
  const { store } = await world(t);
  const forPat = store.contributions('pat', 'sam').map(row => row.item);
  const forRiya = store.contributions('riya', 'sam').map(row => row.item);
  assert.ok(!forPat.includes('secret'), 'the outsider does not see the restricted item id');
  assert.ok(forPat.includes('open'), 'the open item is still listed');
  assert.ok(forRiya.includes('secret'), 'a member of the group sees it');
});

test('an inbound source is actually rate limited', async t => {
  const store = new Store(); t.after(() => store.close());
  const secret = 'this-is-a-long-test-secret'; let now = 9_000_000;
  const integrations = new Integrations(store, { clock: () => now });
  await integrations.addSource('slack', secret, 2);
  const send = n => { const bytes = Buffer.from(JSON.stringify({ problem: `Synthetic failure ${n}`, source_label: 'Synthetic Slack', honesty_label: 'reported' }));
    return () => integrations.receive('slack', String(now), hmac(secret, String(now), bytes), bytes, { 'idempotency-key': `rate-${n}` }); };
  await assert.doesNotReject(send(1)); await assert.doesNotReject(send(2));
  await assert.rejects(send(3), /inbound refused/, 'the third call in the same minute is refused');
  now += 60_000;
  await assert.doesNotReject(send(4), 'the allowance comes back with time');
});

test('workspace research never copies a restricted item’s text into an item that more people can read', async t => {
  const { store } = await world(t);
  store.append('wide', { type: 'posted', actor: 'sam', rules: 3, original: 'Export problem seen in the open', audience: [], at: '2026-11-17T12:02:00.000Z' }, { idem: 'w' });
  store.append('inner', { type: 'posted', actor: 'sam', rules: 3, original: 'Export problem seen by the group', audience: ['Reservations'], at: '2026-11-17T12:03:00.000Z' }, { idem: 'i' });
  store.db.prepare("INSERT OR REPLACE INTO research_config(source,enabled) VALUES('this_workspace',1)").run();
  const { workspaceRecords } = await import('../research/workspace.js');
  const toWide = workspaceRecords(store, 'sam', 'wide', 'Private export problem').map(row => row.item);
  assert.ok(!toWide.includes('secret'), 'restricted text stays out of a workspace-wide item');
  const toInner = workspaceRecords(store, 'sam', 'inner', 'Private export problem').map(row => row.item);
  assert.ok(toInner.includes('secret'), 'a same-audience item can still see it');
  assert.ok(workspaceRecords(store, 'sam', 'inner', 'open workspace problem').map(row => row.item).includes('open'), 'open sources still help restricted items');
});
