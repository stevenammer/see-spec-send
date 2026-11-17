import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; } get statusCode() { return this.status; } set statusCode(v) { this.status = v; } end(v = '') { this.text += v; } write(v) { this.text += v; } }
async function post(handler, path, body, cookie = '', csrf = '') {
  const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: 'sss.example.test', origin: 'http://sss.example.test', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) };
  const res = new Res(); await handler(req, res); return res;
}
const at = n => `2026-11-17T00:00:${String(n).padStart(2, '0')}.000Z`;

test('over HTTP, a comment can anchor to the SPEC only while that SPEC still describes the current SEE', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  for (const id of ['op', 'member']) await auth.createUser(id, 'fixture-password-123', false);
  const append = (event, n) => store.append('i', { ...event, at: at(n) }, { idem: `anchor-${n}` });
  append({ type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see1 = store.read('i').context.seeHash;
  append({ type: 'specced', actor: 'op', see_hash: see1, must: ['one'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec = store.read('i').context.specHash;
  const handler = createHandler({ store, auth, secure: false, origin: 'http://sss.example.test' });
  const login = await post(handler, '/api/login', { id: 'member', password: 'fixture-password-123' });
  const cookie = login.headers['set-cookie'].split(';')[0], csrf = JSON.parse(login.text).csrf;
  const comment = (anchor_kind, anchor_hash) => post(handler, '/api/items/i/events', { type: 'commented', kind: 'comment', comment: 'a thought', anchor_kind, anchor_hash }, cookie, csrf);
  assert.equal((await comment('spec', spec)).status, 201, 'while the SPEC matches the SEE it can be discussed');
  append({ type: 'revised', actor: 'op', text: 'A materially different SEE', base_hash: see1 }, 3);
  const see2 = store.read('i').context.seeHash;
  assert.notEqual(see2, see1);
  assert.equal((await comment('spec', spec)).status, 409, 'once the SEE changed, the old SPEC is stale and cannot be commented on');
  assert.equal((await comment('see', see2)).status, 201, 'the current SEE still can');
});
