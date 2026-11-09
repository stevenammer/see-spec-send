import test from 'node:test';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createServerFor } from '../app/http.js';

test('listener smoke', async () => {
  const store = new Store();
  const auth = new Auth(store);
  await auth.createUser('leader', 'correct-horse-9-battery', true);
  // The configured origin must include the real port, or the same-origin check refuses us.
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = createServerFor({ store, auth, secure: false, origin: base });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'leader', password: 'correct-horse-9-battery' }) });
  const data = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const bad = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.test', 'x-csrf-token': data.csrf }, body: '{}' });
  assert.equal(bad.status, 403);
  const step = await fetch(`${base}/api/stepup`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base, 'x-csrf-token': data.csrf }, body: JSON.stringify({ password: 'correct-horse-9-battery' }) });
  assert.equal(step.status, 204);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
