import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { seedPilot } from '../pilot/kit.js';

class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; } get statusCode() { return this.status; } set statusCode(v) { this.status = v; } end(v = '') { this.text += v; } write(v) { this.text += v; } }
async function get(handler, path, cookie) {
  const req = Readable.from([]); req.method = 'GET'; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: 'sss.example.test', ...(cookie ? { cookie } : {}) };
  const res = new Res(); await handler(req, res); return res;
}

async function world(t) {
  const store = new Store(); t.after(() => store.close()); seedPilot(store, { departments: 2, people: 6 });
  const auth = new Auth(store);
  for (const id of ['pilot-person-001', 'pilot-person-002']) { try { await auth.createUser(id, 'fixture-password-123', false); } catch {} }
  const handler = createHandler({ store, auth, secure: false, origin: 'http://sss.example.test' });
  const sign = async id => `sss=${(await auth.login(id, 'fixture-password-123')).value}`;
  return { store, handler, sign };
}

test('handoff route: needs sign-in and read access, and gives JSON or a markdown download', async t => {
  const { store, handler, sign } = await world(t);
  assert.equal((await get(handler, '/api/items/pilot-1-decided/handoff')).status, 403, 'signed out');
  const reader = await sign('pilot-person-001');
  const json = await get(handler, '/api/items/pilot-1-decided/handoff', reader);
  assert.equal(json.status, 200);
  const packet = JSON.parse(json.text);
  assert.equal(packet.item, 'pilot-1-decided'); assert.equal(packet.erased_text_included, false);
  const md = await get(handler, '/api/items/pilot-1-decided/handoff?format=md', reader);
  assert.equal(md.status, 200);
  assert.match(md.headers['content-type'], /text\/markdown/); assert.match(md.headers['content-disposition'], /attachment/);
  assert.equal(md.headers['x-content-type-options'], 'nosniff');
  assert.match(md.text, /^# Change request: pilot-1-decided/);
  assert.ok(store.canRead('pilot-person-001', 'pilot-1-decided') && !store.canRead('pilot-person-001', 'pilot-2-decided'));
  assert.equal((await get(handler, '/api/items/pilot-2-decided/handoff', reader)).status, 403, 'another department stays out');
});

test('handoff route: an item without a decision is refused with a plain reason, not a stack trace', async t => {
  const { store, handler, sign } = await world(t);
  const reader = await sign('pilot-person-001');
  const open = 'undecided-item';
  store.append(open, { type: 'posted', actor: 'pilot-person-001', rules: 3, original: 'Synthetic open problem.', at: '2026-11-17T12:00:00.000Z' }, { idem: 'open-1' });
  assert.ok(store.canRead('pilot-person-001', open));
  const response = await get(handler, `/api/items/${open}/handoff`, reader);
  assert.equal(response.status, 409); assert.doesNotMatch(response.text, /at .*\.js|Error:/);
});
