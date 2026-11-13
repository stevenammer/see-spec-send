import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { Integrations } from '../app/integrations.js';
import { Ledger } from '../gateway/ledger.js';
import { main as cli } from '../cli.js';

// Bump together with a new entry in core/migrations.js.
const CURRENT = 6;
const temp = () => join(mkdtempSync(join(tmpdir(), 'sss-slice21-')), 'db.sqlite');
const fixtureSql = name => readFileSync(new URL(`./fixtures/golden/${name}.sql`, import.meta.url), 'utf8');

// Golden fixtures are SQL dumps of databases written by earlier commits' own Store code.
function loadFixture(name) {
  const file = temp();
  const db = new DatabaseSync(file);
  db.exec(fixtureSql(name));
  db.exec('PRAGMA journal_mode=WAL');
  db.close();
  return file;
}

function userVersion(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number(db.prepare('PRAGMA user_version').get().user_version); } finally { db.close(); }
}

function backups(file) {
  return readdirSync(dirname(file))
    .filter(name => name.startsWith(`${basename(file)}.`) && name.endsWith('.bak'))
    .map(name => join(dirname(file), name));
}

// Records every SQL string that the open path sends, without changing what runs.
function recordSql(work) {
  const seen = [];
  const { exec, prepare } = DatabaseSync.prototype;
  DatabaseSync.prototype.exec = function record(sql) { seen.push(String(sql)); return exec.call(this, sql); };
  DatabaseSync.prototype.prepare = function record(sql) { seen.push(String(sql)); return prepare.call(this, sql); };
  try { work(); } finally {
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.prepare = prepare;
  }
  return seen;
}

function runChild(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

test('a new database is stamped with the schema version this code knows', () => {
  const file = temp();
  const store = new Store(file);
  store.close();
  assert.equal(userVersion(file), CURRENT);
  assert.deepEqual(backups(file), [], 'a new database has nothing to back up');
});

for (const [name, label] of [
  ['b8847b5-original', 'original schema'],
  ['a6cfd88-pre-authority', 'pre-authority-snapshot schema'],
  ['4699c2d', 'schema at 4699c2d'],
]) {
  test(`golden ${label} migrates once, verifies, and keeps a pre-migration backup beside it`, () => {
    const file = loadFixture(name);
    assert.equal(userVersion(file), 0, 'fixtures predate the version stamp');
    const store = new Store(file);
    try {
      const rows = store.verifyAll();
      assert.ok(rows.length >= 2, 'both items are checked');
      assert.deepEqual(rows.filter(row => !row.ok), []);
    } finally {
      store.close();
    }
    assert.equal(userVersion(file), CURRENT);
    const copies = backups(file);
    assert.equal(copies.length, 1);
    assert.equal(userVersion(copies[0]), 0, 'the backup is the pre-migration database');
  });
}

test('a routine open of a current database runs no schema work, no backfill, and takes no write lock', () => {
  const file = temp();
  new Store(file).close();
  const seen = recordSql(() => {
    const store = new Store(file);
    new Auth(store);
    new Integrations(store);
    new Ledger(store);
    store.close();
  });
  const writes = seen.filter(sql => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|VACUUM)\b|user_version\s*=/i.test(sql));
  assert.deepEqual(writes, []);
  assert.equal(backups(file).length, 0);
});

test('a database stamped with a newer schema refuses to open and is left untouched', () => {
  const file = temp();
  new Store(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${CURRENT + 1}`);
  raw.close();
  const before = readFileSync(file);
  let store = null;
  let thrown = null;
  try { store = new Store(file); } catch (error) { thrown = error; }
  store?.close();
  assert.match(thrown?.message ?? '', /newer/);
  assert.equal(userVersion(file), CURRENT + 1);
  assert.deepEqual(backups(file), []);
  assert.deepEqual(readFileSync(file), before);
});

test('a failed migration rolls back completely and leaves the pre-migration backup', () => {
  const file = loadFixture('a6cfd88-pre-authority');
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE events SET hash='tampered' WHERE item='i' AND seq=2").run();
  raw.close();
  assert.throws(() => new Store(file), /invalid chain/);
  assert.equal(userVersion(file), 0);
  assert.equal(backups(file).length, 1, 'the backup is kept after a failed migration');
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = check.prepare('PRAGMA table_info(events)').all().map(row => row.name);
    assert.ok(!columns.includes('authority_version'), 'the failed step left no column behind');
  } finally {
    check.close();
  }
});

test('a migration waits for the write lock before it takes a backup', () => {
  const file = loadFixture('b8847b5-original');
  const holder = new DatabaseSync(file);
  holder.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => new Store(file), /locked|busy/i);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  assert.deepEqual(backups(file), []);
  assert.equal(userVersion(file), 0);
});

test('processes that open an old database at the same time migrate it once', async () => {
  const file = loadFixture('a6cfd88-pre-authority');
  const module = new URL('../core/store.js', import.meta.url).href;
  const script = `import { Store } from ${JSON.stringify(module)}; const s = new Store(process.argv[1]); s.close();`;
  const results = await Promise.all([0, 1, 2, 3].map(() => runChild(script, [file])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(userVersion(file), CURRENT);
  const copies = backups(file);
  assert.equal(copies.length, 1);
  assert.equal(userVersion(copies[0]), 0);
});

test('migration rechecks the version under the lock and does nothing when another process already migrated', async () => {
  const { migrate } = await import('../core/migrations.js');
  const file = loadFixture('a6cfd88-pre-authority');
  new Store(file).close();
  // The setup migration above made its own backup. Only the stale call below may be measured.
  for (const copy of backups(file)) unlinkSync(copy);
  const direct = new DatabaseSync(file);
  let reads = 0;
  // The first read is stale, as if another process committed between the unlocked read and the lock.
  const stale = {
    exec: sql => direct.exec(sql),
    prepare: sql => {
      if (!/user_version/i.test(sql)) return direct.prepare(sql);
      return { get: () => ({ user_version: reads++ === 0 ? 0 : direct.prepare(sql).get().user_version }) };
    },
  };
  const store = Object.assign(Object.create(Store.prototype), { db: stale, kind: 'sqlite' });
  try {
    migrate(store, file);
  } finally {
    direct.close();
  }
  assert.deepEqual(backups(file), [], 'no second backup and no second migration');
  assert.equal(userVersion(file), CURRENT);
});

test('a schema error that is not a missing column stops the open instead of being swallowed', () => {
  const file = temp();
  const raw = new DatabaseSync(file);
  // bodies is a view, so the erased column cannot be added and the real error must surface.
  raw.exec("CREATE VIEW bodies AS SELECT 'h' AS hash, 'b' AS bytes");
  raw.close();
  assert.throws(() => new Store(file), /view/i);
  assert.equal(userVersion(file), 0);
});

test('migrate --check reports pending work and changes nothing', async () => {
  const file = loadFixture('a6cfd88-pre-authority');
  const before = readFileSync(file);
  const lines = [];
  await cli(['migrate', '--check'], { SSS_DB: file }, line => lines.push(line));
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.current, 0);
  assert.equal(report.target, CURRENT);
  assert.equal(report.pending.length, CURRENT);
  assert.equal(userVersion(file), 0);
  assert.deepEqual(backups(file), []);
  assert.deepEqual(readFileSync(file), before);
});

test('migrate --check does not create a missing database', async () => {
  const file = temp();
  const lines = [];
  await cli(['migrate', '--check'], { SSS_DB: file }, line => lines.push(line));
  assert.equal(existsSync(file), false);
  assert.equal(JSON.parse(lines.join('\n')).present, false);
});

test('migrate applies pending work once and reports the version', async () => {
  const file = loadFixture('4699c2d');
  const lines = [];
  await cli(['migrate'], { SSS_DB: file }, line => lines.push(line));
  assert.equal(userVersion(file), CURRENT);
  assert.equal(backups(file).length, 1);
  assert.equal(JSON.parse(lines.join('\n')).current, CURRENT);
});
