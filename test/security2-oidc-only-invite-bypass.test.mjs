import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}

test('security review: OIDC-only mode refuses password invite redemption', async t => {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store);
  const invite = auth.createInvite('member');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost', disablePasswordLogin: true });
  const req = Readable.from([JSON.stringify({ invite, id: 'member', password: 'member-password-123' })]);
  req.method = 'POST'; req.url = '/api/invite/redeem'; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { 'content-type': 'application/json' };
  const res = new Response(); await handler(req, res);
  assert.notEqual(res.status, 201,
    'the password-login disable flag still lets an invite create a password and immediately issue a password session');
});
