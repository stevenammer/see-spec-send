import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { acquireReplicationLock, everyMilliseconds, promoteStandby, pruneBackups, replicate, replicateOnce } from '../core/standby.js';
import { main as cli } from '../cli.js';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'sss-standby-')); const db = join(root, 'primary.sqlite'); const dir = join(root, 'replica');
  const store = new Store(db); store.registerPerson('writer'); store.append('one', { type: 'checked', actor: 'writer', problem: 'A synthetic standby check.', looked: ['fixture'], found: [], verdict: 'build_needed', at: new Date().toISOString() }, { idem: 'one' }); store.close();
  return { root, db, dir };
};

test('replicate writes a verified backup before atomically publishing latest, and standby restores it', () => {
  const { db, dir, root } = fixture(); const copied = replicateOnce({ file: db, to: dir, keep: 2 });
  const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  assert.equal(latest.backup, copied.backup); assert.equal(latest.events, 1); assert.equal(existsSync(join(dir, latest.backup)), true);
  assert.equal((statSync(join(dir, latest.backup)).mode & 0o077), 0);
  const output = promoteStandby({ from: dir, db: join(root, 'promoted.sqlite'), now: () => Date.parse(latest.at) + 121_000 });
  assert.equal(output.events, 1); assert.match(output.rpo_note, /new writer.*stop the old primary/i);
});

test('a backup changed after writing is rejected and never becomes latest', () => {
  const { db, dir } = fixture();
  assert.throws(() => replicateOnce({ file: db, to: dir, afterWrite: ({ backup }) => appendFileSync(backup, 'tampered') }), /mismatch|verification/);
  assert.equal(existsSync(join(dir, 'latest.json')), false);
});

test('standby refuses a stale replica and a possibly live primary unless forced', () => {
  const { db, dir, root } = fixture(); const copied = replicateOnce({ file: db, to: dir }); const at = Date.parse(copied.at);
  assert.throws(() => promoteStandby({ from: dir, db: join(root, 'stale.sqlite'), maxAgeMs: 60_000, now: () => at + 61_000 }), /older than --max-age/);
  assert.throws(() => promoteStandby({ from: dir, db: join(root, 'live.sqlite'), now: () => at + 1_000 }), /split-brain/);
  assert.equal(promoteStandby({ from: dir, db: join(root, 'forced.sqlite'), force: true, now: () => at + 1_000 }).events, 1);
});

test('replicator lock excludes a second live replicator and prune never deletes newest backup', () => {
  const { db, dir } = fixture(); mkdirSync(dir); const release = acquireReplicationLock(dir);
  assert.throws(() => acquireReplicationLock(dir), /already running/); release();
  replicateOnce({ file: db, to: dir, keep: 10 });
  const first = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).backup;
  replicateOnce({ file: db, to: dir, keep: 10, now: () => new Date(Date.now() + 2_000) });
  const newest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).backup;
  utimesSync(join(dir, first), new Date(1_000), new Date(1_000));
  const result = pruneBackups(dir, 1); assert.equal(result.removed, 1); assert.equal(existsSync(join(dir, newest)), true); assert.equal(existsSync(join(dir, first)), false);
  assert.throws(() => pruneBackups(dir, 0), /positive whole number/);
});

test('replicator accepts documented intervals and stops after three consecutive failures', async () => {
  assert.equal(everyMilliseconds('30s'), 30_000); assert.equal(everyMilliseconds('1h'), 3_600_000); assert.throws(() => everyMilliseconds('five'), /must be like/);
  const { dir } = fixture(); let waits = 0;
  // The replica directory exists before Store opens it, so it is an invalid database path on every attempt.
  await assert.rejects(replicate({ file: dir, to: dir, every: '1s', wait: async () => { waits += 1; } }), /directory|unable to open/);
  assert.equal(waits, 2);
});

test('CLI emits only the promotion JSON for a forced manual promotion', async () => {
  const { db, dir, root } = fixture(); replicateOnce({ file: db, to: dir }); const lines = [];
  await cli(['standby', '--from', dir, '--db', join(root, 'cli.sqlite'), '--force'], {}, line => lines.push(line));
  assert.equal(JSON.parse(lines[0]).events, 1);
});
