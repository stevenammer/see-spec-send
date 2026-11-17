import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { auditRows } from '../core/audit.js';

class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function call(handler, method, path, { cookie = '', csrf = '', body } = {}) {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const req = Readable.from(payload); req.method = method; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: 'sss.example.test', origin: 'http://sss.example.test', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload[0].length) }) };
  const res = new Res(); await handler(req, res); return res;
}
async function world(t) {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('boss', 'fixture-password-123', true); await auth.createUser('helper', 'fixture-password-123', true); await auth.createUser('plain', 'fixture-password-123');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://sss.example.test' });
  const sign = async id => { const s = await auth.login(id, 'fixture-password-123'); return { cookie: `sss=${s.value}`, csrf: s.csrf, value: s.value }; };
  return { store, auth, handler, sign };
}

test('admin routes: only leaders, only with fresh step-up, only with the CSRF token, and each change is audited', async t => {
  const { store, auth, handler, sign } = await world(t);
  const boss = await sign('boss'), plain = await sign('plain');
  const change = (who, body) => call(handler, 'POST', '/api/admin/person', { ...who, body });
  assert.equal((await call(handler, 'GET', '/admin', plain)).status, 403, 'a member cannot open the page');
  assert.equal((await call(handler, 'GET', '/admin', boss)).status, 200);
  assert.equal((await change(plain, { id: 'plain', action: 'promote' })).status, 403, 'a member cannot promote');
  assert.equal((await change(boss, { id: 'plain', action: 'promote' })).status, 403, 'no step-up yet');
  await auth.stepup(boss.value, 'fixture-password-123');
  assert.equal((await change({ cookie: boss.cookie }, { id: 'plain', action: 'promote' })).status, 403, 'no CSRF token');
  assert.equal((await change(boss, { id: 'plain', action: 'promote', extra: 1 })).status, 403, 'unexpected fields');
  assert.equal((await change(boss, { id: 'plain', action: 'promote' })).status, 201);
  assert.equal(store.actor('plain', '').leader, true);
  assert.equal((await change(boss, { id: 'plain', action: 'demote' })).status, 403, 'the step-up was single use');
  const row = auditRows(store.db).find(e => e.what === 'admin person promote');
  assert.ok(row && row.who === 'boss' && row.outcome === 'ok', 'the change is in the audit log, naming who made it');
});

test('an administrator cannot demote or disable their own account, but another leader can be changed', async t => {
  const { store, auth, handler, sign } = await world(t);
  const boss = await sign('boss');
  await auth.stepup(boss.value, 'fixture-password-123');
  for (const action of ['demote', 'disable']) assert.equal((await call(handler, 'POST', '/api/admin/person', { ...boss, body: { id: 'boss', action } })).status, 403, action);
  assert.equal(store.actor('boss', '').leader, true);
  await auth.stepup(boss.value, 'fixture-password-123');
  assert.equal((await call(handler, 'POST', '/api/admin/person', { ...boss, body: { id: 'helper', action: 'demote' } })).status, 201);
});

test('legal hold and retention settings go through the same gates over HTTP', async t => {
  const { store, auth, handler, sign } = await world(t);
  const boss = await sign('boss'), plain = await sign('plain');
  store.append('case', { type: 'posted', actor: 'plain', rules: 3, original: 'Synthetic issue text', at: '2026-01-01T00:00:00.000Z' }, { idem: 'p' });
  const hold = (who, body) => call(handler, 'POST', '/api/admin/hold', { ...who, body });
  assert.equal((await hold(plain, { action: 'set', target_kind: 'item', target_id: 'case', reason: 'preserve for review' })).status, 403);
  await auth.stepup(boss.value, 'fixture-password-123');
  assert.equal((await hold(boss, { action: 'set', target_kind: 'item', target_id: 'case', reason: 'preserve for review' })).status, 201);
  await auth.stepup(boss.value, 'fixture-password-123');
  assert.equal((await call(handler, 'POST', '/api/admin/retention', { ...boss, body: { comments: 30, ledger_answers: 0, closeout_artifacts: 0, receipts: 0 } })).status, 201);
  assert.equal(store.retentionSettings().comments, 30);
  assert.equal((await call(handler, 'POST', '/api/admin/retention', { ...plain, body: { comments: 1, ledger_answers: 1, closeout_artifacts: 1, receipts: 1 } })).status, 403);
  assert.equal(store.retentionSettings().comments, 30, 'a refused change changes nothing');
});
