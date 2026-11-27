import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { recordAnnex } from '../reanalysis/annex.js';

// A fork or renewal copies its parent's text, so restricted work stays restricted: the copy carries the parent's
// audience exactly, and the store refuses any fork that would widen or change it.

const stamp = '2026-11-17T12:00:00.000Z';
async function world(t) {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  for (const id of ['sam', 'riya', 'pat']) await auth.createUser(id, `${id}-long-password-9x`, false);
  store.groupCreate('Reservations', 'night shift'); store.groupAdd('Reservations', 'sam'); store.groupAdd('Reservations', 'riya');
  store.groupCreate('Billing', 'day shift'); store.groupAdd('Billing', 'sam');
  store.append('secret', { type: 'posted', actor: 'sam', rules: 3, original: 'Private export problem for reservations only', audience: ['Reservations'], at: stamp }, { idem: 'p' });
  store.append('open', { type: 'posted', actor: 'sam', rules: 3, original: 'An open workspace problem', audience: [], at: stamp }, { idem: 'o' });
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost', clock: () => Date.parse('2026-11-18T12:00:00.000Z') });
  const sessions = {};
  for (const id of ['sam', 'riya', 'pat']) { const r = await auth.login(id, `${id}-long-password-9x`, '127.0.0.1'); sessions[id] = { cookie: `sss=${r.value}`, origin: 'http://localhost', 'x-csrf-token': r.csrf }; }
  const call = async (method, path, who, input) => {
    const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
    req.method = method; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { ...sessions[who], ...(input === undefined ? {} : { 'content-type': 'application/json' }) };
    const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(c, h = {}) { this.status = c; Object.assign(this.headers, h); }, end(v = '') { this.text += v; } };
    await handler(req, res); return { status: res.status, json: () => JSON.parse(res.text) };
  };
  // A direct store fork of `parent`, as a CLI or import would write it.
  let n = 0;
  const storeFork = (parent, extra = {}) => {
    const point = store.forkPoint(parent, undefined, undefined, { extended: true });
    return store.append(`child-${n += 1}`, { type: 'forked', actor: 'sam', ...point, seed_policy: 2, rules: 3, reason: 'A fork for the test.', at: stamp, ...extra }, { idem: `f-${n}` });
  };
  return { store, call, storeFork };
}

test('a fork of restricted work keeps the audience, so only the same people can read the copy', async t => {
  const { store, call } = await world(t);
  const made = await call('POST', '/api/items/secret/fork', 'sam', { reason: 'Trying the other approach.' });
  assert.equal(made.status, 201);
  const child = made.json().id;
  assert.deepEqual(store.readScope(child).audience, ['Reservations']);
  assert.equal((await call('GET', `/api/items/${child}`, 'pat')).status, 403, 'outsiders still cannot read it');
  assert.equal((await call('GET', `/api/items/${child}`, 'riya')).status, 200, 'the audience can');
  const open = await call('POST', '/api/items/open/fork', 'sam', { reason: 'Trying the other approach.' });
  assert.deepEqual(store.readScope(open.json().id).audience, [], 'a fork of open work stays open');
});

test('the store refuses a fork that drops, widens or changes its parent audience', async t => {
  const { storeFork } = await world(t);
  assert.throws(() => storeFork('secret'), /keeps its parent audience/, 'dropping the audience would open the text to everyone');
  assert.throws(() => storeFork('secret', { audience: ['Billing'] }), /keeps its parent audience/, 'a different group');
  assert.throws(() => storeFork('secret', { audience: ['Reservations', 'Billing'] }), /keeps its parent audience/, 'a wider audience');
  assert.throws(() => storeFork('open', { audience: ['Reservations'] }), /keeps its parent audience/, 'open work forks open');
  storeFork('secret', { audience: ['Reservations'] });
});

test('a renewal of restricted work keeps the audience too', async t => {
  const { store, call } = await world(t);
  const parent = store.eventRows('secret')[0];
  const annex = recordAnnex(store, { v: 1, parent: { item: 'secret', seq: parent.seq, snapshot_hash: parent.hash }, what_is_new: ['A later case found the export works.'] }, { at: stamp }).hash;
  const made = await call('POST', '/api/items/secret/renew', 'sam', { annex, what_is_new: 'A later case found the export works.', reason: 'Asking again on new information.' });
  assert.equal(made.status, 201);
  const child = made.json().id;
  assert.equal(store.events(child)[0].relation, 'renewal');
  assert.deepEqual(store.readScope(child).audience, ['Reservations']);
  assert.equal((await call('GET', `/api/items/${child}`, 'pat')).status, 403);
});

test('a restricted fork survives export and import with its audience', async t => {
  const { store, storeFork } = await world(t);
  storeFork('secret', { audience: ['Reservations'] });
  const id = 'child-1';
  const copy = new Store(); t.after(() => copy.close());
  copy.importJsonl(store.exportJsonl());
  assert.deepEqual(copy.readScope(id).audience, ['Reservations']);
});
