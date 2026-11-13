import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { SCHEMA_VERSION } from '../core/migrations.js';
import { main as cli } from '../cli.js';
import { watchdog } from '../worker/watchdog.js';
import { killed, setKill } from '../worker/control.js';
import { Integrations } from '../app/integrations.js';

const storeModule = new URL('../core/store.js', import.meta.url).href;
const dir = () => mkdtempSync(join(tmpdir(), 'sss-slice20-'));
const quiet = () => {};
const collect = async (argv, env) => { const out = []; await cli(argv, env, line => out.push(line)); return out; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const window = (now, outboxMs = 10) => ({ now, heartbeatMs: 10, runMs: 10, outboxMs });

// A fake Docker: `running` is the set of containers the fake daemon is currently running.
function fakeDocker(running = [], { stubborn = [] } = {}) {
  const calls = []; const alive = new Set(running);
  return {
    calls,
    run() { throw new Error('fake docker does not launch'); },
    inspect(name) { return alive.has(name) ? { State: { Running: true } } : null; },
    kill(name) { calls.push(['kill', name]); if (!stubborn.includes(name)) alive.delete(name); },
    remove(name) { calls.push(['rm', name]); if (!stubborn.includes(name)) alive.delete(name); },
  };
}

function insertDead(store, item, now) {
  store.db.prepare("INSERT INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created) VALUES('d',?,1,'checked','CHECKED','{}','dead',5,0,?)").run(item, now - 100);
}

// Real items: each writer appends a checked item and the events hash-chain per item.
const writerCode = `import {Store} from '${storeModule}';
const s = new Store(process.argv[1]); const id = process.argv[2];
for (let n = 0; n < 150; n += 1) {
  s.append('w' + id + '-' + n, { type: 'checked', actor: 's', at: '2026-11-12', problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }, { idem: 'c' + n });
}
s.close();`;
function writer(path, id) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', writerCode, path, String(id)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, errors }));
  });
}

// B16: a mistyped or missing path must not become a new, empty, "stopped" database.
test('every command except init and restore refuses a missing database and creates nothing', async () => {
  const commands = [
    ['kill', 'set'], ['kill', 'clear'], ['kill', 'status'], ['verify'], ['export'], ['watchdog'],
    ['worker', '--once'], ['migrate'], ['person', 'list'], ['invite', 'list'], ['gateway', 'status'],
    ['integration', 'source', 'list'], ['integration', 'destination', 'list'], ['integration', 'outbox', 'list'],
    ['integration', 'outbox', 'retry', '--id', '1'], ['integration', 'outbox', 'drop', '--id', '1'],
    ['token', 'create', '--kind', 'run', '--item', 'a'], ['provider', 'list'],
  ];
  for (const argv of commands) {
    const file = join(dir(), 'missing.db');
    await assert.rejects(cli(argv, { SSS_DB: file }, quiet), /database missing/, argv.join(' '));
    assert.equal(existsSync(file), false, `${argv.join(' ')} created the database`);
    assert.equal(existsSync(`${file}.kill`), false, `${argv.join(' ')} created a latch`);
  }
  const target = join(dir(), 'never.db');
  await assert.rejects(cli(['backup', '--to', target], { SSS_DB: join(dir(), 'missing.db') }, quiet), /database missing/);
  assert.equal(existsSync(target), false);
});

test('kill set on a mistyped path refuses and leaves nothing behind', async () => {
  const file = join(dir(), 'typo.db');
  await assert.rejects(collect(['kill', 'set'], { SSS_DB: file }), /database missing/);
  assert.equal(existsSync(file), false);
});

test('kill set reports each latch and says stopped only when both are set', async () => {
  const file = join(dir(), 'db'); new Store(file).close();
  const out = await collect(['kill', 'set'], { SSS_DB: file });
  assert.ok(out.includes('file latch: set'), out.join('\n'));
  assert.ok(out.includes('database latch: set'), out.join('\n'));
  assert.equal(out.at(-1), 'stopped');
});

test('kill set tries the database latch even when the file latch cannot be written, and refuses to say stopped', async () => {
  const file = join(dir(), 'db'); new Store(file).close();
  // A directory where the latch file must go makes the file latch fail for real.
  mkdirSync(`${file}.kill`);
  const out = []; let thrown = null;
  try { await cli(['kill', 'set'], { SSS_DB: file }, line => out.push(line)); } catch (error) { thrown = error; }
  assert.match(thrown?.message || '', /not stopped/);
  assert.ok(out.some(line => /^file latch: failed/.test(line)), out.join('\n'));
  assert.ok(out.includes('database latch: set'), out.join('\n'));
  const store = new Store(file);
  assert.equal(store.db.prepare('SELECT killed FROM worker_control WHERE id=1').get().killed, 1);
  store.close();
});

test('a dead delivery alerts once per row and never stops the install', () => {
  const store = new Store(); const now = 1_000_000;
  store.db.prepare('INSERT INTO worker_heartbeat VALUES(1,?)').run(now);
  insertDead(store, 'first', now);
  let result = watchdog(store, window(now));
  assert.equal(result.stopped, false); assert.deepEqual(result.alerted, [1]); assert.equal(killed(store), false);
  result = watchdog(store, window(now + 1));
  assert.deepEqual(result.alerted, [], 'the same dead row alerts only once');
  insertDead(store, 'second', now + 2);
  result = watchdog(store, window(now + 3));
  assert.deepEqual(result.alerted, [2], 'a new dead row alerts again'); assert.equal(result.stopped, false); assert.equal(killed(store), false);
  store.close();
});

test('the watchdog stops once per incident and does not re-fire for an incident it already saw after kill clear', () => {
  const store = new Store(); const now = 1_000_000;
  const stale = at => store.db.prepare('INSERT OR REPLACE INTO worker_heartbeat VALUES(1,?)').run(at);
  store.db.prepare("INSERT INTO runs(id,item,approval,spec_hash,run_actor,gateway_actor,status,delivered,started_at) VALUES('r','item',1,'h','a','b','active',0,?)").run(now);
  stale(now - 100);
  assert.equal(watchdog(store, window(now)).stopped, true);
  setKill(store, false);
  assert.equal(watchdog(store, window(now + 1)).stopped, false, 'the same incident must not re-kill');
  assert.equal(killed(store), false);
  stale(now - 50);
  assert.equal(watchdog(store, window(now + 2)).stopped, true, 'a new heartbeat incident fires again');
  store.close();
});

test('stale sending rows return to pending and never stop the install', () => {
  const store = new Store(); const now = 1_000_000;
  const insert = (item, nextAt) => store.db.prepare("INSERT INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created) VALUES('d',?,1,'checked','CHECKED','{}','sending',0,?,?)").run(item, nextAt, now - 100);
  insert('lapsed', now - 1);
  insert('live', now + 60_000);
  const result = watchdog(store, window(now));
  assert.equal(result.stopped, false);
  const states = Object.fromEntries(store.db.prepare('SELECT item,state FROM integration_outbox').all().map(row => [row.item, row.state]));
  assert.deepEqual(states, { lapsed: 'pending', live: 'sending' });
  store.close();
});

test('the watchdog stops named builder containers and reports one that survives', () => {
  const store = new Store(); const now = 1_000_000;
  const named = (id, name, state) => store.db.prepare('INSERT INTO container_jobs VALUES(?,?,?,?,NULL,?,?,NULL)').run(id, '{}', state, name, now + 60_000, '/tmp/out.html');
  named('a'.repeat(64), 'sss-builder-aaa', 'running');
  named('b'.repeat(64), 'sss-builder-bbb', 'queued');
  named('c'.repeat(64), 'sss-builder-ccc', 'ready');
  named('d'.repeat(64), 'sss-builder-ddd', 'running');
  store.db.prepare('INSERT INTO worker_heartbeat VALUES(1,?)').run(now - 100);
  store.db.prepare("INSERT INTO runs(id,item,approval,spec_hash,run_actor,gateway_actor,status,delivered,started_at) VALUES('r','item',1,'h','a','b','active',0,?)").run(now);
  const docker = fakeDocker(['sss-builder-aaa', 'sss-builder-bbb', 'sss-builder-ddd', 'sss-builder-ccc'], { stubborn: ['sss-builder-ddd'] });
  const result = watchdog(store, { ...window(now), docker });
  assert.equal(result.stopped, true);
  assert.ok(docker.calls.some(call => call[0] === 'kill' && call[1] === 'sss-builder-aaa'));
  assert.ok(docker.calls.some(call => call[0] === 'kill' && call[1] === 'sss-builder-bbb'));
  assert.equal(docker.calls.some(call => call[1] === 'sss-builder-ccc'), false, 'a ready builder is not touched');
  const state = id => store.db.prepare('SELECT state FROM container_jobs WHERE id=?').get(id).state;
  assert.equal(state('a'.repeat(64)), 'stopped');
  assert.equal(state('b'.repeat(64)), 'stopped');
  assert.equal(state('c'.repeat(64)), 'ready');
  assert.equal(state('d'.repeat(64)), 'stop_failed');
  assert.deepEqual(result.builders.filter(row => !row.ok).map(row => row.name), ['sss-builder-ddd']);
  store.close();
});

test('outbox retry and drop act on one row each and leave an audit line', async () => {
  const file = join(dir(), 'db'); const store = new Store(file); const now = 1_000_000;
  insertDead(store, 'retry-me', now); insertDead(store, 'drop-me', now);
  const [retry, drop] = store.db.prepare('SELECT id FROM integration_outbox ORDER BY id').all().map(row => row.id);
  store.close();
  await cli(['integration', 'outbox', 'retry', '--id', String(retry)], { SSS_DB: file }, quiet);
  await cli(['integration', 'outbox', 'drop', '--id', String(drop)], { SSS_DB: file }, quiet);
  const reopened = new Store(file);
  const state = id => reopened.db.prepare('SELECT state,attempts FROM integration_outbox WHERE id=?').get(id);
  assert.equal(state(retry).state, 'pending'); assert.equal(state(retry).attempts, 0);
  assert.equal(state(drop).state, 'dropped');
  const audit = reopened.db.prepare("SELECT action FROM worker_history WHERE action LIKE 'outbox.%' ORDER BY seq").all().map(row => row.action);
  assert.deepEqual(audit, [`outbox.retry:${retry}`, `outbox.drop:${drop}`]);
  reopened.close();
});

test('backups taken while writers run each verify, and the final backup holds every event', async () => {
  const root = dir(); const source = join(root, 'source.db');
  const store = new Store(source); store.registerPerson('s'); store.close();
  const writers = [1, 2].map(id => writer(source, id));
  let writing = true;
  const finished = Promise.all(writers).then(results => { writing = false; return results; });
  const copies = []; const counts = [];
  // Backups keep running until the writers finish, so most of them land mid-stream.
  for (let index = 0; index < 20 || (writing && index < 200); index += 1) {
    const target = join(root, `backup-${index}.db`);
    await cli(['backup', '--to', target], { SSS_DB: source }, quiet);
    copies.push(target);
    const manifest = JSON.parse(readFileSync(`${target}.manifest.json`, 'utf8'));
    assert.equal(manifest.sha256, sha(readFileSync(target)), 'manifest hash matches the copy');
    counts.push(manifest.events);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  for (const { code, errors } of await finished) assert.equal(code, 0, errors);
  assert.ok(counts.some(events => events > 0 && events < 300), `a backup must land mid-stream, saw ${counts.join(',')}`);
  assert.deepEqual([...counts].sort((a, b) => a - b), counts, 'each backup sees a prefix of the stream');
  for (const copy of copies) {
    const check = new Store(copy);
    assert.equal(check.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const rows = check.verifyAll();
    assert.ok(rows.every(row => row.ok), JSON.stringify(rows.filter(row => !row.ok)));
    assert.equal(rows.length, JSON.parse(readFileSync(`${copy}.manifest.json`, 'utf8')).items, 'the copy holds exactly the items its manifest names');
    check.close();
  }
  // A quiet snapshot after the writers finish must hold every event, not a prefix.
  const finalCopy = join(root, 'final.db');
  await cli(['backup', '--to', finalCopy], { SSS_DB: source }, quiet);
  const final = JSON.parse(readFileSync(`${finalCopy}.manifest.json`, 'utf8'));
  const last = new Store(source); const sourceEvents = last.db.prepare('SELECT count(*) AS n FROM events').get().n; last.close();
  assert.equal(sourceEvents, 300);
  assert.equal(final.events, 300, 'the final backup drops no events');
  assert.equal(final.items, 300);
});

test('backup refuses a damaged source and leaves no copy behind', async () => {
  const root = dir(); const source = join(root, 'source.db'); const target = join(root, 'copy.db');
  const store = new Store(source); store.registerPerson('s');
  store.append('one', { type: 'checked', actor: 's', at: '2026-11-12', problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }, { idem: 'c1' });
  store.db.prepare("UPDATE events SET hash='forged' WHERE item='one'").run();
  store.close();
  await assert.rejects(cli(['backup', '--to', target], { SSS_DB: source }, quiet), /verification/);
  assert.equal(existsSync(target), false); assert.equal(existsSync(`${target}.manifest.json`), false);
});

test('restore refuses a copy whose manifest hash matches but whose chain does not verify', async () => {
  const root = dir(); const source = join(root, 'source.db'); const backup = join(root, 'backup.db'); const restored = join(root, 'restored.db');
  const store = new Store(source); store.registerPerson('s');
  store.append('one', { type: 'checked', actor: 's', at: '2026-11-12', problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }, { idem: 'c1' });
  store.close();
  await cli(['backup', '--to', backup], { SSS_DB: source }, quiet);
  const raw = new DatabaseSync(backup); raw.exec("UPDATE events SET hash='forged'"); raw.close();
  const bytes = readFileSync(backup);
  const manifestPath = `${backup}.manifest.json`; const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.sha256 = sha(bytes); manifest.bytes = bytes.length;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(cli(['restore', '--from', backup], { SSS_DB: restored }, quiet), /verification/);
  assert.equal(existsSync(restored), false); assert.equal(existsSync(`${restored}-wal`), false);
});

test('restore refuses stray -wal or -shm files and a manifest mismatch, verifies, and leaves kill set', async () => {
  const root = dir(); const source = join(root, 'source.db'); const backup = join(root, 'backup.db'); const restored = join(root, 'restored.db');
  const store = new Store(source); store.registerPerson('s'); store.close();
  await cli(['backup', '--to', backup], { SSS_DB: source }, quiet);
  const env = { SSS_DB: restored };
  for (const stray of ['-wal', '-shm']) {
    writeFileSync(`${restored}${stray}`, 'stray');
    await assert.rejects(cli(['restore', '--from', backup], env, quiet), new RegExp(`stray ${stray}`), stray);
    assert.equal(existsSync(restored), false, `${stray} refusal must not create the database`);
    unlinkSync(`${restored}${stray}`);
  }
  const manifestPath = `${backup}.manifest.json`; const good = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, good.replace(/"sha256": "[a-f0-9]{64}"/, `"sha256": "${'0'.repeat(64)}"`));
  await assert.rejects(cli(['restore', '--from', backup], env, quiet), /backup manifest mismatch/);
  assert.equal(existsSync(restored), false);
  unlinkSync(manifestPath);
  await assert.rejects(cli(['restore', '--from', backup], env, quiet), /backup manifest missing/, 'a backup without a manifest is refused');
  writeFileSync(manifestPath, good);
  await cli(['restore', '--from', backup], env, quiet);
  assert.equal(existsSync(`${restored}-wal`), false);
  assert.equal(statSync(restored).mode & 0o077, 0);
  const copy = new Store(restored);
  assert.equal(killed(copy), true, 'the restored copy starts stopped');
  assert.ok(copy.verifyAll().every(row => row.ok));
  copy.close();
  assert.equal(existsSync(`${restored}.kill`), true, 'the file latch is set beside the restored copy');
});

test('backup manifest records the latch state at backup time', async () => {
  const root = dir(); const source = join(root, 'source.db'); const target = join(root, 'copy.db');
  new Store(source).close();
  await cli(['kill', 'set'], { SSS_DB: source }, quiet);
  await cli(['backup', '--to', target], { SSS_DB: source }, quiet);
  const manifest = JSON.parse(readFileSync(`${target}.manifest.json`, 'utf8'));
  assert.equal(manifest.latch.database, true);
  assert.equal(manifest.latch.file, true);
  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.equal(manifest.events, 0);
});

test('a watchdog tick while a row is being sent leaves that row sending', async () => {
  const store = new Store(); const now = 1_000_000; let during = null;
  store.db.prepare("INSERT INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created) VALUES('receiver','i',1,'checked','CHECKED','{}','pending',0,?,?)").run(now, now);
  store.db.prepare("INSERT INTO integration_destinations(name,url,secret,include_text,enabled,allow_loopback) VALUES('receiver','http://127.0.0.1/test','this-is-a-long-test-secret',0,1,1)").run();
  const fetcher = async () => { watchdog(store, window(now)); during = store.db.prepare('SELECT state FROM integration_outbox').get().state; return { ok: true }; };
  const integrations = new Integrations(store, { clock: () => now, fetcher });
  assert.equal(await integrations.deliverOnce(), true);
  assert.equal(during, 'sending', 'a live claim is not recovered by a watchdog tick');
  assert.equal(store.db.prepare('SELECT state FROM integration_outbox').get().state, 'delivered');
  store.close();
});

test('integration outbox delivery still refuses a row that another worker is sending', async () => {
  const store = new Store(); const now = 1_000_000;
  store.db.prepare("INSERT INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created) VALUES('d','i',1,'checked','CHECKED','{}','sending',0,?,?)").run(now + 60_000, now);
  const integrations = new Integrations(store, { clock: () => now, fetcher: async () => { throw new Error('must not send'); } });
  assert.equal(await integrations.deliverOnce(), false);
  store.close();
});
