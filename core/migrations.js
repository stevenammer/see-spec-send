import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BASELINE_SCHEMA, LEGACY_COLUMNS } from './schema.js';

// Ordered and append-only. A released step is never edited; a change gets a new step.
// PRAGMA user_version stores how many steps this database has had applied.
export const MIGRATIONS = Object.freeze([
  { name: 'baseline schema', up: store => { store.db.exec(BASELINE_SCHEMA); addMissingColumns(store.db); } },
  { name: 'integration source actor kind', up: store => store.migrateActorKinds() },
  { name: 'submitted-event hashes', up: store => store.backfillSubmittedHashes() },
  { name: 'authority snapshots and derived item cache', up: store => store.backfillAuthoritySnapshots() },
  { name: 'legacy gateway policy copy', up: store => copyLegacyPolicy(store.db) },
  { name: 'F1 rules 2 Effort actors, jobs, receipts, and run iterations', up: store => store.migrateF1() },
]);
export const SCHEMA_VERSION = MIGRATIONS.length;

export const userVersion = db => Number(db.prepare('PRAGMA user_version').get().user_version);

function refuseNewer(version) {
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema version ${version} is newer than this code supports (${SCHEMA_VERSION}); refusing to open it`);
  }
}

function addMissingColumns(db) {
  for (const [table, column, definition] of LEGACY_COLUMNS) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function copyLegacyPolicy(db) {
  const legacy = db.prepare('SELECT * FROM gateway_policy WHERE id=1').get();
  if (legacy) db.prepare('INSERT OR IGNORE INTO gateway_policy_versions VALUES(1,?,?)').run(legacy.bytes, legacy.seal);
}

// The copy is taken through a second connection. In WAL mode it reads the last committed
// state while this migration holds the write lock, so it is the pre-migration database.
function backupBeforeMigration(store, file) {
  if (!file || file === ':memory:' || !existsSync(file)) return null;
  const tables = Number(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n);
  if (tables === 0) return null;
  const target = `${file}.pre-v${SCHEMA_VERSION}.bak`;
  if (existsSync(target)) unlinkSync(target);
  const reader = new DatabaseSync(file);
  try {
    reader.prepare('VACUUM INTO ?').run(target);
  } finally {
    reader.close();
  }
  chmodSync(target, 0o600);
  return target;
}

// Opening a current database does no schema work: one read, then return.
export function migrate(store, file) {
  const { db } = store;
  const version = userVersion(db);
  refuseNewer(version);
  if (version === SCHEMA_VERSION) return { from: version, to: version, applied: [], backup: null };
  db.exec('BEGIN IMMEDIATE'); // migration-lock
  try {
    const current = userVersion(db); // in-lock-recheck
    refuseNewer(current);
    if (current === SCHEMA_VERSION) {
      db.exec('COMMIT');
      return { from: current, to: current, applied: [], backup: null };
    }
    const backup = backupBeforeMigration(store, file);
    const applied = [];
    for (let index = current; index < SCHEMA_VERSION; index += 1) {
      MIGRATIONS[index].up(store);
      applied.push(MIGRATIONS[index].name);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
    return { from: current, to: SCHEMA_VERSION, applied, backup };
  } catch (error) {
    try { db.exec('ROLLBACK'); /* migration-rollback */ } catch {}
    throw error;
  }
}

// Read-only report for `migrate --check`. Never creates, locks or writes the file.
export function migrationStatus(file) {
  const pending = MIGRATIONS.map(step => step.name);
  if (!existsSync(file)) return { present: false, target: SCHEMA_VERSION, pending };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const current = userVersion(db);
    return {
      present: true,
      current,
      target: SCHEMA_VERSION,
      newer: current > SCHEMA_VERSION,
      pending: MIGRATIONS.slice(Math.min(current, SCHEMA_VERSION)).map(step => step.name),
    };
  } finally {
    db.close();
  }
}
