import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function call(handler, method, path, input, headers = {}) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path;
  req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res); let body; try { body = JSON.parse(res.text); } catch { body = null; }
  return { status: res.status, headers: res.headers, text: res.text, body };
}

// A first leader signs in with a temporary password. The browser must lead them to a screen that changes it.
test('a temporary password sends the person to a screen that changes it', async () => {
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth, secure: false, origin: 'http://127.0.0.1' });
  await auth.createUser('boss', 'Temp-password-9a-zz', true, { mustChange: true });
  const login = await call(handler, 'POST', '/api/login', { id: 'boss', password: 'Temp-password-9a-zz' });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const headers = { cookie, origin: 'http://127.0.0.1', 'x-csrf-token': login.body.csrf };
  const home = await call(handler, 'GET', '/', undefined, headers);
  assert.equal(home.status, 302); assert.equal(home.headers.location, '/password');
  const screen = await call(handler, 'GET', '/password', undefined, headers);
  assert.equal(screen.status, 200); assert.match(screen.text, /data-password/);
  assert.equal((await call(handler, 'GET', '/api/items', undefined, headers)).status, 403, 'data routes stay closed');
  await call(handler, 'POST', '/api/stepup', { password: 'Temp-password-9a-zz' }, headers);
  const changed = await call(handler, 'POST', '/api/password', { password: 'A-real-password-chosen-1' }, headers);
  assert.equal(changed.status, 200);
  const fresh = { cookie: changed.headers['set-cookie'].split(';')[0], origin: 'http://127.0.0.1', 'x-csrf-token': changed.body.csrf };
  assert.equal((await call(handler, 'GET', '/', undefined, fresh)).status, 200, 'the new session reaches the home page');
});

test('the page script wires the password screen to step-up then change', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(script, /form\.dataset\.password[\s\S]{0,200}\/api\/stepup', \{ password: input\.current \}[\s\S]{0,120}\/api\/password', \{ password: input\.password \}/);
});
