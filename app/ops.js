import { existsSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store.js';
import { SCHEMA_VERSION, userVersion } from '../core/migrations.js';
import { verifyAudit } from '../core/audit.js';
import { killed } from '../worker/control.js';

const table = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const countBy = (db, sql) => Object.fromEntries(db.prepare(sql).all().map(row => [String(row.state ?? row.status), Number(row.n)]));
const noPeople = value => JSON.parse(JSON.stringify(value));

export function ready(store) {
  try {
    const version = userVersion(store.db);
    const latch = killed(store) ? 'stopped' : 'clear';
    return { ok: version === SCHEMA_VERSION, schema_version: version, expected_schema_version: SCHEMA_VERSION, kill_latch: latch };
  } catch {
    return { ok: false, schema_version: null, expected_schema_version: SCHEMA_VERSION, kill_latch: 'unavailable' };
  }
}

export function metrics(store, { requests = {}, signIns = {}, startedAt = Date.now(), now = Date.now, databaseSize = () => 0 } = {}) {
  const db = store.db;
  const knowledge = store.knowledge.verify();
  const reanalysis = table(db, 'knowledge_log')
    ? db.prepare("SELECT at FROM knowledge_log WHERE kind IN ('delta','annex') ORDER BY seq DESC LIMIT 1").get()?.at ?? null : null;
  return noPeople({
    requests, sign_in_outcomes: signIns,
    gateway_receipts: table(db, 'gateway_receipts') ? countBy(db, 'SELECT state,count(*) n FROM gateway_receipts GROUP BY state') : {},
    worker_runs: table(db, 'runs') ? countBy(db, 'SELECT status,count(*) n FROM runs GROUP BY status') : {},
    knowledge: { length: table(db, 'knowledge_log') ? Number(db.prepare('SELECT count(*) n FROM knowledge_log').get().n) : 0, chain: knowledge.ok ? 'ok' : 'failed' },
    digest_backlog: table(db, 'digest_entries') ? Number(db.prepare('SELECT count(*) n FROM digest_entries WHERE seen_at IS NULL').get().n) : 0,
    reanalysis_last_run: reanalysis, database_bytes: Number(databaseSize()) || 0,
    schema_version: userVersion(db), uptime_ms: Math.max(0, now() - startedAt),
  });
}

const mode = path => statSync(path).mode & 0o777;
const ownerOnly = path => !existsSync(path) || (mode(path) & 0o077) === 0;
const backupFiles = dir => !dir || !existsSync(dir) ? [] : readdirSync(dir).filter(name => !name.endsWith('.manifest.json')).map(name => join(dir, name)).filter(path => existsSync(`${path}.manifest.json`));

// The source database is opened read-only. A disposable copy is used for the
// Store verifier because Store deliberately enables SQLite pragmas on open.
export function doctor(file, { backupDir = null, serveArgs = [], nodeVersion = process.versions.node, temp = () => mkdtempSync(join(tmpdir(), 'sss-doctor-')) } = {}) {
  const report = { database: { present: existsSync(file), readable: false, schema_version: null }, chains: {}, kill_latch: 'unavailable', permissions: {}, backup: null, serve: { ok: true }, scheduler_lock: existsSync(`${file}.reanalysis.lock`), disk_headroom_bytes: null, node: { version: nodeVersion, ok: false } };
  const [major, minor] = String(nodeVersion).split('.').map(Number); report.node.ok = major > 22 || (major === 22 && minor >= 19);
  if (!report.database.present) return report;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    report.database.readable = true; report.database.schema_version = userVersion(db);
    report.chains.audit = verifyAudit(db);
    db.close();
    const directory = temp(); const copy = join(directory, 'copy.sqlite');
    // copyFile is intentionally avoided here so the checker has one explicit
    // read path; SQLite backup through VACUUM would write the source lock.
    const bytes = readFileSync(file); awaitWrite(copy, bytes);
    const store = new Store(copy); report.chains.items = store.verifyAll(); report.chains.knowledge = store.knowledge.verify(); report.kill_latch = killed(store) ? 'stopped' : 'clear'; store.close();
    rmSync(directory, { recursive: true, force: true });
  } catch (error) { report.database.error = String(error.message).slice(0, 160); }
  report.permissions.database = { mode: mode(file), owner_only: ownerOnly(file) };
  report.permissions.key_files = [`${file}.secret-key`, `${file}.kill`].filter(existsSync).map(path => ({ path: basename(path), mode: mode(path), owner_only: ownerOnly(path) }));
  if (backupDir) {
    const files = backupFiles(backupDir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const newest = files[0];
    if (!newest) report.backup = { present: false, fresh: false };
    else {
      let manifest = null; try { manifest = JSON.parse(readFileSync(`${newest}.manifest.json`, 'utf8')); } catch {}
      const age = manifest?.created_at ? Date.now() - Date.parse(manifest.created_at) : Infinity;
      report.backup = { present: true, fresh: Number.isFinite(age) && age <= 24 * 60 * 60 * 1000, age_ms: age };
    }
  }
  try { const space = statfsSync(file); report.disk_headroom_bytes = Number(space.bavail) * Number(space.bsize); } catch {}
  if (serveArgs.length) {
    try { // defer import cycle through a deliberately tiny parser-free sanity check
      const host = serveArgs.includes('--host') ? serveArgs[serveArgs.indexOf('--host') + 1] : '127.0.0.1';
      const tlsCert = serveArgs.includes('--tls-cert'), tlsKey = serveArgs.includes('--tls-key');
      report.serve.ok = Boolean(host) && tlsCert === tlsKey;
    } catch { report.serve.ok = false; }
  }
  return report;
}

function awaitWrite(path, bytes) { writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); }
