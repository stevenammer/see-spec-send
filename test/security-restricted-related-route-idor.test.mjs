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

test('the related-work route does not derive a search query from a restricted original', async t => {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store), password = 'synthetic-password-9';
  await auth.createUser('steward', password, false); await auth.createUser('outsider', password, false);
  store.groupCreate('private-group', 'synthetic restricted group'); store.groupAdd('private-group', 'steward');
  store.append('restricted-case', { type: 'posted', actor: 'steward', rules: 3,
    original: 'zephyr birch cobalt confidential workflow detail', audience: ['private-group'], at: '2026-11-16T12:00:00.000Z' }, { idem: 'restricted-post' });
  const login = await auth.login('outsider', password, '127.0.0.1');
  const req = Readable.from([]); req.method = 'GET'; req.url = '/items/restricted-case/related';
  req.headers = { cookie: `sss=${login.value}` }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await createHandler({ store, auth, secure: false, origin: 'http://localhost' })(req, res);

  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, /zephyr birch cobalt/);
});
