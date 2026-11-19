import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import * as app from '../app/http.js';
import { killed } from '../worker/control.js';
import { decide, runReset, latchStatus, nextUtcDay } from '../deploy/hosted-demo/reset.js';
import { ROSTER, seedDemo } from '../deploy/hosted-demo/seed.js';

const at = iso => () => new Date(iso);
const fresh = () => join(mkdtempSync(join(tmpdir(), 'sss-demo-reset-')), 'sss.db');
const state = db => JSON.parse(readFileSync(`${db}.reset-state.json`, 'utf8'));

test('decide: window edges, one reset per day, force only lifts the window', () => {
  assert.equal(decide({ now: new Date('2026-11-20T00:00:00Z') }).ok, true);
  assert.equal(decide({ now: new Date('2026-11-20T00:09:59Z') }).ok, true);
  assert.equal(decide({ now: new Date('2026-11-20T00:10:00Z') }).ok, false);
  assert.equal(decide({ now: new Date('2026-11-19T23:59:59Z') }).ok, false);
  assert.equal(decide({ now: new Date('2026-11-20T12:00:00Z'), force: true }).midDay, true);
  assert.equal(decide({ now: new Date('2026-11-20T00:03:00Z'), force: true }).midDay, false);
  assert.equal(decide({ now: new Date('2026-11-20T00:03:00Z'), state: { lastResetDay: '2026-11-20' }, force: true }).ok, false);
  assert.equal(nextUtcDay(new Date('2026-12-31T23:00:00Z')), '2027-01-01');
});

test('reset outside the window is refused and leaves the database alone', () => {
  const db = fresh(); seedDemo(db);
  const before = readFileSync(db);
  const result = runReset({ db, now: at('2026-11-20T12:00:00Z') });
  assert.equal(result.done, false); assert.match(result.reason, /outside 00:00 to 00:10 UTC/);
  assert.deepEqual(readFileSync(db), before); assert.equal(existsSync(`${db}.reset-state.json`), false);
});

test('in-window reset restores the seed, drops added data, and leaves no latch', () => {
  const db = fresh(); seedDemo(db);
  const store = new Store(db); store.registerPerson('reviewer-ada'); store.close();
  const result = runReset({ db, now: at('2026-11-20T00:02:00Z') });
  assert.equal(result.done, true); assert.equal(result.killed, false);
  const after = new Store(db);
  assert.equal(after.db.prepare("SELECT count(*) n FROM actors WHERE id='reviewer-ada'").get().n, 0);
  assert.equal(after.db.prepare("SELECT count(*) n FROM actors WHERE kind='person'").get().n, ROSTER.length);
  assert.equal(killed(after), false); after.close();
  assert.equal(state(db).lastResetDay, '2026-11-20');
});

test('a second reset the same UTC day is refused, even with force', () => {
  const db = fresh();
  assert.equal(runReset({ db, now: at('2026-11-20T00:01:00Z') }).done, true);
  const again = runReset({ db, now: at('2026-11-20T00:05:00Z') });
  assert.equal(again.done, false); assert.match(again.reason, /already reset/);
  const forced = runReset({ db, now: at('2026-11-20T15:00:00Z'), force: true });
  assert.equal(forced.done, false); assert.match(forced.reason, /already reset/);
  assert.equal(runReset({ db, now: at('2026-11-21T00:01:00Z') }).done, true);
});

test('forced mid-day reset sets the kill latch until the next UTC day; the next scheduled reset clears it', () => {
  const db = fresh(); seedDemo(db);
  const forced = runReset({ db, now: at('2026-11-20T15:30:00Z'), force: true });
  assert.equal(forced.done, true); assert.equal(forced.killed, true);
  assert.equal(latchStatus(db), 'stopped'); assert.equal(existsSync(`${db}.kill`), true);
  assert.deepEqual({ ...state(db) }, { lastResetDay: '2026-11-20', killUntilDay: '2026-11-21', killSetByReset: true });
  const next = runReset({ db, now: at('2026-11-21T00:00:30Z') });
  assert.equal(next.done, true); assert.equal(next.killed, false);
  assert.equal(latchStatus(db), 'clear'); assert.equal(existsSync(`${db}.kill`), false);
});

test('check mode decides without changing anything', () => {
  const db = fresh(); seedDemo(db);
  const before = readFileSync(db);
  assert.equal(runReset({ db, now: at('2026-11-20T00:01:00Z'), check: true }).check, true);
  assert.equal(runReset({ db, now: at('2026-11-20T09:00:00Z'), check: true }).done, false);
  assert.deepEqual(readFileSync(db), before); assert.equal(existsSync(`${db}.reset-state.json`), false);
});

test('an owner-set latch survives the scheduled reset', () => {
  const db = fresh(); seedDemo(db);
  writeFileSync(`${db}.kill`, 'stop\n');
  const result = runReset({ db, now: at('2026-11-20T00:01:00Z') });
  assert.equal(result.killed, true); assert.equal(latchStatus(db), 'stopped');
  assert.equal(runReset({ db, now: at('2026-11-21T00:01:00Z') }).killed, true);
});

test('a failed seed leaves the old database in place and records nothing', () => {
  const db = fresh(); seedDemo(db);
  const before = readFileSync(db);
  assert.throws(() => runReset({ db, now: at('2026-11-20T00:01:00Z'), seed: () => { throw new Error('boom'); } }), /boom/);
  assert.deepEqual(readFileSync(db), before); assert.equal(existsSync(`${db}.reset-state.json`), false);
});

test('seed holds only the invented roster, with no accounts or invites', () => {
  const db = fresh(); seedDemo(db, { now: new Date('2026-11-20T00:00:00Z') });
  const store = new Store(db);
  const people = store.db.prepare("SELECT id FROM actors WHERE kind='person' ORDER BY id").all().map(row => row.id);
  assert.deepEqual(people, ROSTER.map(person => person.id).sort());
  assert.equal(store.db.prepare('SELECT count(*) n FROM users').get().n, 0);   // no passwords, no logins until an invite is redeemed
  assert.equal(store.db.prepare('SELECT count(*) n FROM invites').get().n, 0);
  store.close();
});

test('demo banner appears on the sign-in page only when SSS_DEMO_BANNER=1', async t => {
  const store = new Store(); const auth = new Auth(store);
  const server = app.createServerFor({ store, auth, secure: false, origin: 'http://127.0.0.1:0' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  const get = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/signin' }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body));
  }).on('error', reject));
  const saved = process.env.SSS_DEMO_BANNER;
  try {
    delete process.env.SSS_DEMO_BANNER;
    assert.doesNotMatch(await get(), /demo-banner/);
    process.env.SSS_DEMO_BANNER = '1';
    const html = await get();
    assert.match(html, /<body><p class="demo-banner" role="note">/);
    assert.match(html, /made-up data/); assert.match(html, /00:00 UTC/); assert.match(html, /real information/);
  } finally { if (saved === undefined) delete process.env.SSS_DEMO_BANNER; else process.env.SSS_DEMO_BANNER = saved; }
});

test('hosted compose: hardened, no published ports, cloudflared shares the app namespace, fixture worker only, token only via env file', () => {
  const dir = new URL('../deploy/hosted-demo/', import.meta.url);
  const compose = readFileSync(new URL('compose.yaml', dir), 'utf8');
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(compose, /network_mode: "service:app"/);
  assert.match(compose, /cap_drop: \[ALL\]/); assert.match(compose, /no-new-privileges:true/); assert.match(compose, /read_only: true/);
  assert.match(compose, /"--builder", "fixture"/); assert.doesNotMatch(compose, /docker\.sock/);
  assert.match(compose, /--trusted-proxy/); assert.doesNotMatch(compose, /insecure-cookies/);
  assert.match(compose, /SSS_DEMO_BANNER: "1"/);
  assert.match(compose, /cloudflare\/cloudflared@sha256:[0-9a-f]{64}/);
  assert.match(compose, /env_file: \.\/tunnel\.env/);
  const env = readFileSync(new URL('tunnel.env.example', dir), 'utf8');
  assert.match(env, /TUNNEL_TOKEN=REPLACE_ME/);
  assert.doesNotMatch(compose + env, /eyJ[A-Za-z0-9_-]{30,}/);
});

test('--init seeds a first install only, and never replaces an existing database', () => {
  const db = fresh();
  assert.equal(runReset({ db, now: at('2026-11-20T13:00:00Z'), init: true }).done, true);
  assert.equal(existsSync(`${db}.reset-state.json`), false); assert.equal(latchStatus(db), 'clear');
  const again = runReset({ db, now: at('2026-11-20T13:05:00Z'), init: true });
  assert.equal(again.done, false); assert.match(again.reason, /database already exists/);
});
