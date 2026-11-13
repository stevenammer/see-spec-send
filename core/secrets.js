import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Integration secrets are stored as AES-256-GCM ciphertext. The key lives in a file outside the database
// and outside backups (default: next to the database, named <database>.secret-key, owner-only).
// A stolen database file or backup therefore does not hand over any webhook secret.
const PREFIX = 'enc1:';

export function keyFileFor(database, env = process.env) {
  if (env.SSS_SECRET_KEY_FILE) return resolve(env.SSS_SECRET_KEY_FILE);
  if (!database || database === ':memory:') return null;
  return resolve(dirname(database), `${resolve(database).split('/').pop()}.secret-key`);
}

export function loadKey(path, { create = true } = {}) {
  if (!path) return randomBytes(32); // in-memory databases: the key dies with the process
  if (!existsSync(path)) {
    if (!create) throw Error(`secret key file missing: ${path}`);
    writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  if (statSync(path).mode & 0o077) { chmodSync(path, 0o600); }
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw Error('secret key file must hold 32 bytes as hex');
  return key;
}

export const sealed = value => typeof value === 'string' && value.startsWith(PREFIX);

export function seal(key, plain) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

// Legacy plaintext rows (written before this slice) are returned as is and sealed on next write.
export function open(key, stored) {
  if (!sealed(stored)) return stored;
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
