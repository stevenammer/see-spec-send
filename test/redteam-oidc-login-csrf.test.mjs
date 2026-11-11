import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { FakeOidcProvider, OidcLogin } from '../app/oidc.js';
import { createHandler } from '../app/http.js';

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}

async function call(handler, path) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = path;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response();
  await handler(req, res);
  return res;
}

test('redteam: an OIDC callback must be bound to the browser that started it', async () => {
  const provider = new FakeOidcProvider();
  const oidc = new OidcLogin(provider.configuration('https://localhost/api/oidc/callback'));
  const store = new Store();
  const handler = createHandler({ store, auth: new Auth(store, { oidc }), secure: true });

  // Attacker starts a transaction, authenticates their own IdP account, then sends
  // the callback URL to a separate victim browser.  No cookie or other browser
  // binding accompanies either request.
  const started = await call(handler, '/api/oidc/start');
  const authorization = new URL(started.headers.location);
  const code = provider.issue({
    codeChallenge: authorization.searchParams.get('code_challenge'),
    nonce: authorization.searchParams.get('nonce'),
    subject: 'attacker-identity',
  });
  const victimCallback = await call(handler,
    `/api/oidc/callback?state=${encodeURIComponent(authorization.searchParams.get('state'))}&code=${encodeURIComponent(code)}`);

  assert.equal(victimCallback.status, 400,
    'a callback from a browser that did not start this state must be refused');
});
