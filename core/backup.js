import { chmodSync, closeSync, constants, copyFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { userVersion } from './migrations.js';
import { setKill } from '../worker/control.js';

// A backup is a VACUUM INTO snapshot: one read transaction, so writers that keep appending
// cannot tear the copy. The copy is verified before it is named a backup, and a manifest
// records what was verified so a restore can check the bytes before it opens them.
const FORMAT = 'sss-backup-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = file => `${file}.manifest.json`;
const remove = file => { for (const path of [file, `${file}-wal`, `${file}-shm`]) rmSync(path, { force: true }); };

// Encrypted backups: AES-256-GCM with a 32-byte key kept in a key file the operator stores apart
// from the backup. The key is never written into the backup or its manifest.
const MAGIC = Buffer.from('SSS-BACKUP-AES256GCM-1\n');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function backupKey(keyFile, { create }) {
  if (create && !existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error('backup key file must hold exactly 32 bytes');
  return key;
}

function sealBackup(plain, key) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
}

function openBackup(sealed, keyFile) {
  const head = MAGIC.length + NONCE_BYTES + TAG_BYTES;
  if (sealed.length < head || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('encrypted backup is malformed');
  const key = backupKey(keyFile, { create: false });
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES));
  decipher.setAuthTag(sealed.subarray(MAGIC.length + NONCE_BYTES, head));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(head)), decipher.final()]);
  } catch {
    throw new Error('backup key does not open this backup');
  }
}

function integrityOf(store) {
  return store.db.prepare('PRAGMA integrity_check').get().integrity_check;
}

function snapshot(store, target) {
  store.db.prepare('VACUUM INTO ?').run(target);
}

// Opens the copy through Store so the same chain, cache and state checks run as `verify`.
function verifyCopy(file) {
  const store = new Store(file);
  try {
    const integrity = integrityOf(store);
    const rows = store.verifyAll();
    const bad = rows.filter(row => !row.ok);
    if (integrity !== 'ok' || bad.length) {
      throw new Error(`copy failed verification: integrity ${integrity}, ${bad.length} item(s) not ok`);
    }
    return {
      events: Number(store.db.prepare('SELECT count(*) AS n FROM events').get().n),
      items: rows.length,
      schema_version: userVersion(store.db),
    };
  } finally {
    store.close();
  }
}

// With keyFile, the plaintext snapshot is staged beside the target, sealed into the target, and
// the staging files are removed. Without it, the snapshot is the target, as before.
export function writeBackup(store, target, { keyFile = null } = {}) {
  if (existsSync(target) || existsSync(manifestPath(target))) throw new Error('backup target exists');
  const key = keyFile ? backupKey(keyFile, { create: true }) : null;
  const staging = keyFile ? `${target}.plain` : target;
  const latch = {
    database: store.db.prepare('SELECT killed FROM worker_control WHERE id=1').get().killed === 1,
    file: Boolean(store.killFile && existsSync(store.killFile)),
  };
  closeSync(openSync(target, 'wx', 0o600));
  try {
    if (keyFile) closeSync(openSync(staging, 'wx', 0o600));
    snapshot(store, staging);
    const counts = verifyCopy(staging);
    const bytes = readFileSync(staging);
    if (keyFile) writeFileSync(target, sealBackup(bytes, key));
    chmodSync(target, 0o600);
    const manifest = {
      format: FORMAT, created_at: new Date().toISOString(), sha256: sha(bytes), bytes: bytes.length,
      events: counts.events, items: counts.items, schema_version: counts.schema_version, latch,
      ...(keyFile ? { encrypted: true } : {}),
    };
    writeFileSync(manifestPath(target), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return manifest;
  } catch (error) {
    remove(target);
    throw error;
  } finally {
    if (keyFile) remove(staging);
  }
}

export function restoreBackup(source, file, { keyFile = null } = {}) {
  if (!existsSync(source)) throw new Error('backup missing');
  if (existsSync(file)) throw new Error('restore target already exists');
  for (const stray of ['-wal', '-shm']) {
    if (existsSync(`${file}${stray}`)) throw new Error(`restore target has a stray ${stray} file; move it aside first`);
  }
  if (!existsSync(manifestPath(source))) throw new Error('backup manifest missing; refusing to restore an unverified backup');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath(source), 'utf8')); } catch { throw new Error('backup manifest is unreadable'); }
  const raw = readFileSync(source);
  if (manifest.encrypted && !keyFile) throw new Error('encrypted backup needs --key-file; refusing to restore');
  const bytes = manifest.encrypted ? openBackup(raw, keyFile) : raw;
  if (manifest.format !== FORMAT || manifest.sha256 !== sha(bytes) || manifest.bytes !== bytes.length) {
    throw new Error('backup manifest mismatch; refusing to restore');
  }
  if (manifest.encrypted) writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  else copyFileSync(source, file, constants.COPYFILE_EXCL);
  chmodSync(file, 0o600);
  let store = null;
  try {
    store = new Store(file);
    const integrity = integrityOf(store);
    const rows = store.verifyAll();
    if (integrity !== 'ok' || rows.some(row => !row.ok)) throw new Error('restored copy failed verification');
    const events = Number(store.db.prepare('SELECT count(*) AS n FROM events').get().n);
    if (events !== manifest.events) throw new Error('restored event count does not match the manifest');
    // A restored copy starts stopped. An operator clears the stop only after checking the restore.
    setKill(store, true);
  } catch (error) {
    if (store) store.close();
    remove(file);
    throw error;
  }
  store.close();
  return manifest;
}
