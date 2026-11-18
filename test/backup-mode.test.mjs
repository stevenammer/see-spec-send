import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { writeBackup } from '../core/backup.js';

const mode = path => statSync(path).mode & 0o777;

test('a backup, its manifest and its key are owner-only even under a permissive umask', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-backup-mode-'));
  const store = new Store(join(dir, 'db.sqlite')); t.after(() => store.close());
  store.registerPerson('nick');
  const previous = process.umask(0);
  try {
    const plain = join(dir, 'plain.sqlite');
    writeBackup(store, plain);
    assert.equal(mode(plain).toString(8), '600', 'the plain backup');
    assert.equal(mode(`${plain}.manifest.json`).toString(8), '600', 'its manifest');
    const sealed = join(dir, 'sealed.sqlite'), keyFile = join(dir, 'backup.key');
    writeBackup(store, sealed, { keyFile });
    assert.equal(mode(sealed).toString(8), '600', 'the encrypted backup');
    assert.equal(mode(`${sealed}.manifest.json`).toString(8), '600', 'its manifest');
    assert.equal(mode(keyFile).toString(8), '600', 'the key file');
  } finally {
    process.umask(previous);
  }
});
