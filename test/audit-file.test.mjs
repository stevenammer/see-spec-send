import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; } get statusCode() { return this.status; } set statusCode(v) { this.status = v; } end(v = '') { this.text += v; } write(v) { this.text += v; } }
async function post(handler, path, body, cookie = '', csrf = '') {
  const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: 'sss.example.test', origin: 'http://sss.example.test', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) };
  const res = new Res(); await handler(req, res); return res;
}

test('the audit file only ever grows: earlier sign-ins and refusals survive later ones, and the file is owner-only', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('maya', 'fixture-password-123', false);
  const file = join(mkdtempSync(join(tmpdir(), 'sss-auditfile-')), 'audit.jsonl');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://sss.example.test', auditLog: file });
  const login = await post(handler, '/api/login', { id: 'maya', password: 'fixture-password-123' });
  assert.equal(login.status, 200);
  const first = readFileSync(file, 'utf8');
  assert.match(first, /"what":"sign_in"/);
  const again = await post(handler, '/api/login', { id: 'maya', password: 'fixture-password-123' });
  assert.equal(again.status, 200);
  assert.ok((await post(handler, '/api/login', { id: 'maya', password: 'wrong-password-123' })).status >= 400);
  const cookie = again.headers['set-cookie'].split(';')[0], csrf = JSON.parse(again.text).csrf;
  const made = await post(handler, '/api/items', { original: 'Synthetic audit-file problem.' }, cookie, csrf);
  assert.equal(made.status, 201);
  const later = readFileSync(file, 'utf8');
  assert.ok(later.startsWith(first), 'the first entry is still at the top, not overwritten');
  const lines = later.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.length >= 3, `three attempts, ${lines.length} lines`);
  assert.equal(lines.filter(line => line.who === 'maya' && line.what === 'sign_in').length >= 2, true);
  assert.ok(lines.some(line => line.what === 'scope_change' && line.who === 'maya'), 'the item write is in the log too');
  assert.equal(statSync(file).mode & 0o077, 0, 'no group or world access');
});
