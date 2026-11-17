import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { restoreBackup, verifyBackup, writeBackup } from './backup.js';
import { SCHEMA_VERSION } from './migrations.js';
import { verifyAudit } from './audit.js';

const lockName = 'replicate.lock';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function everyMilliseconds(value = '5m') {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error('--every must be like 30s, 5m, or 1h');
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('--every must be a positive duration');
  return amount * ({ s: 1000, m: 60_000, h: 3_600_000 }[match[2]]);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// O_EXCL makes acquisition atomic. A stale lock is recoverable only after its recorded pid is gone.
export function acquireReplicationLock(dir) {
  const path = join(dir, lockName);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (let attempts = 0; attempts < 2; attempts += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`);
      closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(readFileSync(path, 'utf8'));
          if (current.token === token) rmSync(path, { force: true });
        } catch { /* A removed or unreadable lock is no longer ours to remove. */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = {};
      try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('replicator lock is unreadable; remove it only after checking no replicator is running'); }
      if (pidAlive(holder.pid)) throw new Error(`replicator already running (pid ${holder.pid})`);
      rmSync(path, { force: true });
    }
  }
  throw new Error('could not acquire replicator lock');
}

export function backupPaths(dir) {
  return readdirSync(dir).map(name => join(dir, name))
    .filter(path => path.endsWith('.sqlite') && existsSync(`${path}.manifest.json`))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

// The newest file is immutable. A backup that cannot be verified is evidence, not a pruning target.
export function pruneBackups(dir, keep, { keyFile = null } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive whole number');
  const backups = backupPaths(dir); let retained = 0; let removed = 0;
  for (let index = 0; index < backups.length; index += 1) {
    const source = backups[index]; const scratch = join(dir, `.verify-${process.pid}-${index}.sqlite`); let valid = false;
    try { valid = verifyBackup(source, scratch, { keyFile }).ok; } catch { /* Keep corrupt copies for investigation. */ }
    if (index === 0 || !valid || retained < keep) { retained += valid ? 1 : 0; continue; }
    rmSync(source, { force: true }); rmSync(`${source}.manifest.json`, { force: true }); removed += 1;
  }
  return { removed, retained: backups.length - removed };
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function replicateOnce({ file, to, keyFile = null, keep = 7, now = () => new Date(), afterWrite = () => {} }) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const release = acquireReplicationLock(to);
  try {
    const at = now();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const backup = join(to, `sss-${stamp}-${process.pid}.sqlite`);
    const store = new Store(file);
    let manifest;
    try { manifest = writeBackup(store, backup, { keyFile }); } finally { store.close(); }
    afterWrite({ backup, manifest });
    // writeBackup verifies its snapshot; verifyBackup independently restores it before it can become latest.
    const scratch = join(to, `.verify-${process.pid}-${Date.now()}.sqlite`);
    try { verifyBackup(backup, scratch, { keyFile }); }
    catch (error) { rmSync(backup, { force: true }); rmSync(`${backup}.manifest.json`, { force: true }); throw error; }
    const latest = { at: at.toISOString(), events: manifest.events, items: manifest.items, backup: backup.split('/').pop(), sha256: manifest.sha256, host: hostname() };
    atomicJson(join(to, 'latest.json'), latest);
    const pruned = pruneBackups(to, keep, { keyFile });
    return { ...latest, pruned };
  } finally { release(); }
}

export async function replicate({ file, to, keyFile = null, keep = 7, every = '5m', once = false, log = () => {}, wait = sleep }) {
  const interval = everyMilliseconds(every); let failures = 0;
  while (true) {
    try {
      const result = replicateOnce({ file, to, keyFile, keep }); failures = 0; log(JSON.stringify(result));
      if (once) return result;
    } catch (error) {
      failures += 1; log(`replicate failed (${failures}/3): ${error.message}`);
      if (failures >= 3 || once) throw error;
    }
    await wait(interval);
  }
}

export function promoteStandby({ from, db, keyFile = null, maxAgeMs = 15 * 60_000, force = false, now = () => Date.now() }) {
  if (existsSync(db)) throw new Error('standby needs a new database: --db already exists');
  let latest;
  try { latest = JSON.parse(readFileSync(join(from, 'latest.json'), 'utf8')); } catch { throw new Error('latest.json is missing or unreadable'); }
  if (typeof latest.at !== 'string' || typeof latest.backup !== 'string' || !Number.isInteger(latest.events) || !Number.isInteger(latest.items)) throw new Error('latest.json is malformed');
  if (latest.backup.includes('/') || latest.backup.includes('\\')) throw new Error('latest.json names an unsafe backup path');
  const age = (now() - Date.parse(latest.at)) / 1000;
  if (!Number.isFinite(age) || age < 0) throw new Error('latest.json has an invalid timestamp');
  if (!force && age * 1000 > maxAgeMs) throw new Error('replica is older than --max-age; refusing stale promotion without --force');
  if (!force && age < 120) throw new Error('primary may still be replicating; refusing split-brain promotion without --force');
  const source = join(from, latest.backup);
  const manifest = restoreBackup(source, db, { keyFile });
  if (manifest.schema_version !== SCHEMA_VERSION) { rmSync(db, { force: true }); throw new Error('backup schema is not current; refusing promotion'); }
  if (manifest.sha256 !== latest.sha256 || manifest.events !== latest.events || manifest.items !== latest.items) { rmSync(db, { force: true }); throw new Error('latest.json does not match its verified backup'); }
  const restored = new Store(db);
  try {
    const itemsOk = restored.verifyAll().every(row => row.ok);
    if (!itemsOk || !restored.knowledge.verify().ok || !verifyAudit(restored.db).ok) throw new Error('promoted copy failed doctor-style hash-chain verification');
  } catch (error) {
    restored.close(); rmSync(db, { force: true }); throw error;
  }
  restored.close();
  return { restored_from: source, backup_age_seconds: Math.floor(age), events: manifest.events, items: manifest.items,
    rpo_note: 'Promoted database is a new writer. Stop the old primary before clearing its stop latch or starting writes.' };
}
