import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { killed, setKill } from '../worker/control.js';
import { Worker } from '../worker/runner.js';

test('database path aliases share the independent emergency latch', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sss-worker-path-'));
  const file = join(directory, 'work.db');
  const alias = join(directory, 'alias.db');
  const first = new Store(file);
  symlinkSync(file, alias);
  const second = new Store(alias);
  t.after(() => {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // A file-only latch must work while the database update is unavailable or pending.
  writeFileSync(first.killFile, 'stop\n', { mode: 0o600 });
  assert.equal(killed(first), true);
  assert.equal(killed(second), true);
  assert.equal(first.killFile, second.killFile);
});

test('a stopped approval never submits another adapter start request', t => {
  const store = new Store();
  t.after(() => store.close());
  store.registerPerson('writer');
  store.registerPerson('leader', { leader: true });
  let sequence = 0;
  const append = (type, actor, data) => store.append('item', {
    type, actor, at: '2026-11-10', ...data,
  }, { idem: `setup:${sequence++}` });
  append('checked', 'writer', {
    problem: 'A synthetic problem', looked: ['Checked existing options'],
    found: [], verdict: 'build_needed',
  });
  append('specced', 'writer', {
    must: ['One small test'], how_we_know: ['A visible result'], out_of_scope: [],
  });
  append('approved', 'leader', {
    spec_hash: store.read('item').context.specHash, cap_usd: 0, quorum: 1,
  });
  const starts = [];
  const adapter = {
    start: request => starts.push(request),
    status: () => ({ state: 'running' }),
    stop: () => ({ state: 'stopped' }),
  };
  const worker = new Worker(store, adapter);
  worker.reconcile();
  assert.equal(starts.length, 1);
  setKill(store, true);
  worker.reconcile();
  assert.equal(starts.length, 1);
  assert.equal(store.read('item').state, 'SPECCED');
});
