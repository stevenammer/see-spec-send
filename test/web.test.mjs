import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

const password = 'correct-horse-9-battery';
class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function call(handler, method, path, input, headers = {}) { const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path; req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' }; const res = new Response(); await handler(req, res); return { ...res, body: res.text && res.headers['content-type']?.includes('json') ? JSON.parse(res.text) : {} }; }
const cookie = response => response.headers['set-cookie'].split(';')[0];
test('manual web path is authorized, escaped, sandboxed, and has strict pages', async () => {
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth });
  for (const [id, leader] of [['lead', true], ['steward', false], ['one', false], ['two', false], ['member', false]]) await auth.createUser(id, password, leader);
  const login = async id => { const response = await call(handler, 'POST', '/api/login', { id, password }); const me = response.body; return { cookie: cookie(response), headers: { cookie: cookie(response), origin: 'https://localhost', 'x-csrf-token': me.csrf } }; };
  const l = await login('lead'); const s = await login('steward'); const m = await login('member'); const send = (who, path, input) => call(handler, 'POST', path, input, who.headers);
  assert.equal((await call(handler, 'GET', '/api/items')).status, 403);
  const bad = '<img src=x onerror=alert(1)>';
  const made = await send(s, '/api/items', { problem: bad, have: true, have_note: 'looked', verdict: 'build_needed' }); assert.equal(made.status, 201); const id = made.body.id;
  assert.equal(Object.hasOwn(store.listItems()[0], 'helper_names'), false);
  assert.equal((await send(s, '/api/items', { have: true, have_note: 'looked', verdict: 'build_needed' })).status, 409);
  assert.equal((await send(m, `/api/items/${id}/events`, { type: 'specced', must: ['x'], how_we_know: ['x'], out_of_scope: [] })).status, 409);
  assert.equal((await send(s, `/api/items/${id}/events`, { type: 'specced', must: ['x'], how_we_know: ['x'], out_of_scope: [] })).status, 201);
  assert.equal((await send(m, `/api/items/${id}/events`, { type: 'approved', cap_usd: 1, quorum: 2 })).status, 403);
  await send(l, '/api/stepup', { password }); assert.equal((await send(l, `/api/items/${id}/events`, { type: 'approved', cap_usd: 1, quorum: 2 })).status, 201);
  assert.equal((await send(m, `/api/items/${id}/artifact`, { html: '<h1>x</h1>' })).status, 409);
  assert.equal((await send(s, `/api/items/${id}/artifact`, { html: '<script>window.x=1</script></iframe><a href="javascript:alert(1)">x</a>' })).status, 201);
  const state = store.read(id); const artifact = await call(handler, 'GET', `/api/items/${id}/artifact/${state.context.artifact}`, undefined, s.headers); assert.match(artifact.headers['content-security-policy'], /sandbox allow-scripts/); assert.match(artifact.text, /<script>/);
  assert.equal((await send(s, `/api/items/${id}/events`, { type: 'helped', artifact_hash: state.context.artifact })).status, 409);
  assert.equal((await send(l, `/api/items/${id}/events`, { type: 'helped', artifact_hash: state.context.artifact })).status, 409);
  const one = await login('one'); const two = await login('two'); assert.equal((await send(one, `/api/items/${id}/events`, { type: 'helped', artifact_hash: state.context.artifact })).status, 201); assert.equal((await send(one, `/api/items/${id}/events`, { type: 'helped', artifact_hash: state.context.artifact })).status, 201); assert.equal((await send(two, `/api/items/${id}/events`, { type: 'helped', artifact_hash: state.context.artifact })).status, 201);
  assert.equal(store.read(id).state, 'HELPS');
  const rendered = await call(handler, 'GET', `/items/${id}`, undefined, s.headers); assert.match(rendered.headers['content-security-policy'], /script-src 'self'/); assert.match(rendered.text, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.equal(rendered.text.includes('<img src=x onerror'), false); assert.equal(/<script(?! src=)/.test(rendered.text), false); assert.equal(/style=/.test(rendered.text), false);
  assert.equal((await send(s, `/api/items/${id}/artifact`, { html: 'x'.repeat(256 * 1024 + 1) })).status, 409);
});
