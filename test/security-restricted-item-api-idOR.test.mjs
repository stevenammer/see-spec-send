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

async function call(handler, headers, path) {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = path; req.socket = { remoteAddress: '127.0.0.1' }; req.headers = headers;
  const res = new Response(); await handler(req, res); return res;
}

test('a signed-in person outside an audience cannot read raw events through the generic item API', async t => {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store), password = 'synthetic-password-9';
  await auth.createUser('steward', password, false);
  await auth.createUser('outsider', password, false);
  store.groupCreate('private-group', 'synthetic restricted group');
  store.groupAdd('private-group', 'steward');
  store.append('restricted-case', { type: 'posted', actor: 'steward', rules: 3,
    original: 'Synthetic restricted text that must not cross the audience boundary.', audience: ['private-group'],
    at: '2026-11-16T12:00:00.000Z' }, { idem: 'restricted-post' });
  const login = await auth.login('outsider', password, '127.0.0.1');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const res = await call(handler, { cookie: `sss=${login.value}` }, '/api/items/restricted-case');

  // This must be the same read denial used by the item, artifact, and history routes.
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, /Synthetic restricted text/);
});
