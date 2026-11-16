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
async function get(handler, path, headers = {}) {
  const req = Readable.from([]); req.method = 'GET'; req.url = path; req.headers = headers; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res); return res;
}

test('security review: arbitrary unmatched paths do not create unbounded metrics keys', async t => {
  const store = new Store(); t.after(() => store.close());
  const handler = createHandler({ store, auth: new Auth(store), metricsToken: 'synthetic-metrics-token' });
  for (const suffix of ['one', 'two', 'three']) assert.equal((await get(handler, `/attacker-controlled-${suffix}`)).status, 403);
  const metrics = await get(handler, '/metrics-lite', { authorization: 'Bearer synthetic-metrics-token' });
  assert.equal(metrics.status, 200);
  const requests = JSON.parse(metrics.text).requests;
  assert.equal(Object.keys(requests).filter(key => key.startsWith('/attacker-controlled-')).length, 0,
    'unknown routes must use a single route template instead of retaining attacker-chosen path strings');
});
