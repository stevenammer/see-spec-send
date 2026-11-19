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
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { QuestGateway } from '../gateway/quest.js';
import { AnalysisGateway } from '../gateway/analysis.js';
import { DatabaseSync } from 'node:sqlite';

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

// ---- The money ledger survives a reset ----------------------------------------------------------------------------------
const DAY1 = Date.parse('2026-11-19T12:00:00Z');
const MODEL = 'fixture:text-v1';
const ok = { output: 'ok', usage: { input_tokens: 10, output_tokens: 10 } };
// Spends real fixture money through the Quest and analysis lanes on the demo database, as the app would on a day before the reset.
async function spendSome(db, { policy = {}, quest = ['ann', 'bo'], analysis = ['cy'] } = {}) {
  const store = new Store(db);
  try {
    const ledger = new Ledger(store, { clock: () => DAY1 });
    ledger.setPolicy({ ...fixturePolicy(), ...policy });
    const q = new QuestGateway(ledger, async () => ok, { clock: () => DAY1 });
    for (const [i, person] of quest.entries()) await q.call(person, `q${i}`, { model: MODEL, input: 'hello there', max_output_tokens: 16 });
    const a = new AnalysisGateway(ledger, async () => ok, { clock: () => DAY1 });
    for (const [i, person] of analysis.entries()) await a.ask(person, `a${i}`, { question: 'hello there' });
    const rows = ledger.allMeteredReceipts();
    return { rows: rows.length, total: rows.reduce((n, r) => n + r.charged_micros, 0), policy: ledger.policy(), versions: ledger.policyVersions().length };
  } finally { store.close(); }
}
const readLedger = db => {
  const store = new Store(db);
  try {
    const ledger = new Ledger(store, { clock: () => DAY1 });
    const rows = ledger.allMeteredReceipts();   // re-verifies every seal and the receipt count
    const on = day => rows.filter(r => r.day === day).reduce((n, r) => n + r.charged_micros, 0);
    return { rows: rows.length, lifetime: rows.reduce((n, r) => n + r.charged_micros, 0), day: on('2026-11-19'), policy: ledger.policy(), versions: ledger.policyVersions().length, holdAudits: ledger.holdAudits().length };
  } finally { store.close(); }
};

test('reset keeps the day total and the lifetime total (a) and the policy (b); receipt seals still verify (c)', async () => {
  const db = fresh(); seedDemo(db);
  const spent = await spendSome(db, { policy: { global_micros: 123_456, day_micros: 99_000 } });
  assert.ok(spent.rows === 3 && spent.total > 0, `spent ${spent.total} in ${spent.rows} receipts`);
  const result = runReset({ db, now: at('2026-11-20T00:02:00Z') });
  assert.equal(result.done, true);
  const after = readLedger(db);                       // throws on a bad seal or a wrong receipt count (c)
  assert.equal(after.rows, 3);
  assert.equal(after.day, spent.total);               // (a) the 2026-11-19 day total is intact
  assert.equal(after.lifetime, spent.total);          // (a) and so is the lifetime total
  assert.deepEqual(after.policy, spent.policy);       // (b)
  assert.equal(after.policy.global_micros, 123_456); assert.equal(after.policy.day_micros, 99_000);
  assert.equal(after.versions, spent.versions);
});

test('reset still wipes the demo content: people, posts, accounts, invites, sessions, reflections', async () => {
  const db = fresh(); seedDemo(db);
  await spendSome(db);
  const store = new Store(db);
  store.registerPerson('reviewer-ada');
  store.append('private-idea', { type: 'posted', actor: 'reviewer-ada', rules: 3, audience: [], original: 'A private visitor idea', at: '2026-11-19T10:00:00.000Z' }, { idem: 'p1' });
  store.db.prepare("INSERT INTO invites(digest,role,expires,used) VALUES('inv','member',9999999999,0)").run();
  store.db.prepare("INSERT INTO sessions(digest,person,csrf,created,seen,expires) VALUES('sess','reviewer-ada','c',1,1,9999999999)").run();
  store.close();
  assert.equal(runReset({ db, now: at('2026-11-20T00:02:00Z') }).done, true);
  const raw = new DatabaseSync(db);
  const n = sql => raw.prepare(sql).get().n;
  assert.equal(n("SELECT count(*) n FROM actors WHERE id='reviewer-ada'"), 0);
  assert.equal(n("SELECT count(*) n FROM events WHERE item='private-idea'"), 0);
  assert.equal(n('SELECT count(*) n FROM invites'), 0); assert.equal(n('SELECT count(*) n FROM sessions'), 0);
  assert.equal(n('SELECT count(*) n FROM users'), 0);
  assert.equal(n("SELECT count(*) n FROM actors WHERE kind='person'"), ROSTER.length);
  assert.equal(n('SELECT count(*) n FROM gateway_quest_receipts'), 2);   // the ledger stayed, the content did not
  raw.close();
});

test('a failure mid-copy leaves the old database byte-for-byte intact and no half-built file behind (e)', async () => {
  const db = fresh(); seedDemo(db);
  await spendSome(db);
  const store = new Store(db); store.close();          // settle the WAL so the bytes are stable
  const before = readFileSync(db);
  let seen = 0;
  assert.throws(() => runReset({ db, now: at('2026-11-20T00:02:00Z'), afterTable: () => { if (++seen === 2) throw new Error('disk gave out mid-copy'); } }), /disk gave out/);
  assert.ok(seen >= 2);
  assert.deepEqual(readFileSync(db), before);
  assert.equal(existsSync(`${db}.reset-state.json`), false); assert.equal(existsSync(`${db}.seed`), false);
  assert.equal(readLedger(db).rows, 3);
  // and a retry after the fault is gone succeeds
  assert.equal(runReset({ db, now: at('2026-11-20T00:03:00Z') }).done, true);
  assert.equal(readLedger(db).rows, 3);
});

test('a tampered receipt is caught before the swap and the old database stays', async () => {
  const db = fresh(); seedDemo(db);
  await spendSome(db);
  const raw = new DatabaseSync(db); raw.exec("UPDATE gateway_quest_receipts SET charged_micros=0 WHERE rowid=1"); raw.close();
  const before = readFileSync(db);
  assert.throws(() => runReset({ db, now: at('2026-11-20T00:02:00Z') }), /corrupt/);
  assert.deepEqual(readFileSync(db), before); assert.equal(existsSync(`${db}.seed`), false);
});

test('a lifetime cap used up before the reset still refuses after it (f)', async () => {
  const db = fresh(); seedDemo(db);
  const spent = await spendSome(db);
  // Lifetime cap now equals what was spent, so nothing more is admitted, on any day.
  const set = new Store(db); new Ledger(set).setPolicy({ ...fixturePolicy(), global_micros: spent.total + 5, day_micros: 1_000_000 }); set.close();
  assert.equal(runReset({ db, now: at('2026-11-20T00:02:00Z') }).done, true);
  const store = new Store(db);
  try {
    const nextDay = Date.parse('2026-11-20T00:05:00Z');
    const q = new QuestGateway(new Ledger(store, { clock: () => nextDay }), async () => { throw new Error('provider must not be called'); }, { clock: () => nextDay });
    await assert.rejects(() => q.call('new-visitor', 'after-reset', { model: MODEL, input: 'hello there', max_output_tokens: 16 }), /global cap exceeded/);
  } finally { store.close(); }
});

test('the daily cap keeps counting across a forced mid-day reset (the kill latch stays too)', async () => {
  const db = fresh(); seedDemo(db);
  const spent = await spendSome(db, { policy: { day_micros: 0 + 10_000 } });
  const forced = runReset({ db, now: at('2026-11-19T15:00:00Z'), force: true });
  assert.equal(forced.done, true); assert.equal(forced.killed, true);
  assert.equal(readLedger(db).day, spent.total);
});

test('a fixture-only demo with an empty ledger resets and keeps a working policy', () => {
  const db = fresh(); seedDemo(db);
  assert.equal(runReset({ db, now: at('2026-11-20T00:02:00Z') }).done, true);
  const after = readLedger(db);
  assert.equal(after.rows, 0); assert.equal(after.policy.enabled, true);
});

test('the Vertex example files are valid, carry no credential, and are labelled as examples', async () => {
  const { validateProvider } = await import('../provider/config.js');
  const dir = new URL('../deploy/hosted-demo/', import.meta.url);
  const providerText = readFileSync(new URL('vertex.provider.example.json', dir), 'utf8');
  const policyText = readFileSync(new URL('gateway-policy.vertex.example.json', dir), 'utf8');
  const provider = JSON.parse(providerText); validateProvider(provider);
  assert.equal(provider.kind, 'vertex'); assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  assert.doesNotMatch(providerText + policyText, /BEGIN PRIVATE KEY|private_key|AIza|ya29\.|\/home\//);
  const store = new Store();
  try { new Ledger(store).configure(JSON.parse(policyText)); assert.equal(new Ledger(store).policy().day_micros, 15_000_000); } finally { store.close(); }
});
