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

test('the event route refuses Vision Quest material, authority fields and a client-chosen actor, and writes nothing', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  for (const id of ['op', 'member']) await auth.createUser(id, 'fixture-password-123', false);
  store.append('i', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2, at: '2026-11-17T00:00:01.000Z' }, { idem: 'p' });
  const see = store.read('i').context.seeHash;
  const handler = createHandler({ store, auth, secure: false, origin: 'http://sss.example.test' });
  const login = await post(handler, '/api/login', { id: 'member', password: 'fixture-password-123' });
  const cookie = login.headers['set-cookie'].split(';')[0], csrf = JSON.parse(login.text).csrf;
  const send = extra => post(handler, '/api/items/i/events', { type: 'commented', kind: 'comment', comment: 'a thought', anchor_kind: 'see', anchor_hash: see, ...extra }, cookie, csrf);
  assert.equal((await send({})).status, 201, 'a plain comment is accepted');
  const before = store.events('i').length;
  for (const [extra, status] of [[{ quest: { turns: [] } }, 409], [{ questMemo: { recommendation: 'build' } }, 409], [{ actor: 'op' }, 403], [{ role: 'leader' }, 403]]) {
    const response = await send(extra);
    assert.equal(response.status, status, `${Object.keys(extra)[0]} is refused`);
    assert.deepEqual(JSON.parse(response.text), { error: 'request refused' });
  }
  assert.equal(store.events('i').length, before, 'none of the refused events were written');
});
