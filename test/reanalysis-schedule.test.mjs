import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReanalysisSchedule, acquireLock } from '../reanalysis/schedule.js';

const fakeTimers = () => { const t = { fn: null, cleared: false }; return { t, setTimer: fn => { t.fn = fn; return { unref() {} }; }, clearTimer: () => { t.cleared = true; } }; };
const dir = () => mkdtempSync(join(tmpdir(), 'sss-sched-'));
const result = { deltas: [], annexes: [], delivery: { entries: 0 } };

test('the interval is validated and an absent flag means no scheduler', () => {
  const lockFile = join(dir(), 'l');
  for (const bad of [0, 4, 1441, 1.5, '10', NaN, undefined]) assert.throws(() => startReanalysisSchedule({}, { intervalMinutes: bad, lockFile }), /interval must be/);
});

test('a pass runs on the timer with the injected clock, logs counts, and stop releases the lock', () => {
  const { t, setTimer, clearTimer } = fakeTimers(); const lockFile = join(dir(), 'l'); const logs = []; const seen = [];
  const s = startReanalysisSchedule({}, { intervalMinutes: 10, lockFile, clock: () => Date.parse('2026-11-16T12:00:00Z'), log: m => logs.push(m), setTimer, clearTimer, run: (_s, o) => { seen.push(o.now); return result; } });
  assert.ok(existsSync(lockFile)); assert.equal(t.fn(), 'ran'); assert.deepEqual(seen, ['2026-11-16T12:00:00.000Z']); assert.match(logs[0], /deltas=0 annexes=0/);
  s.stop(); assert.ok(t.cleared); assert.equal(existsSync(lockFile), false);
});

test('a slow pass is never overlapped, and a failing pass is contained', () => {
  const { t, setTimer, clearTimer } = fakeTimers(); const lockFile = join(dir(), 'l'); const logs = []; let inner;
  startReanalysisSchedule({}, { intervalMinutes: 5, lockFile, log: m => logs.push(m), setTimer, clearTimer, run: () => { inner = t.fn(); return result; } });
  assert.equal(t.fn(), 'ran'); assert.equal(inner, 'skipped', 'a tick during a running pass is skipped');
  const second = fakeTimers();
  startReanalysisSchedule({}, { intervalMinutes: 5, lockFile: join(dir(), 'l2'), log: m => logs.push(m), setTimer: second.setTimer, clearTimer: second.clearTimer, run: () => { throw new Error('boom'); } });
  assert.equal(second.t.fn(), 'failed'); assert.ok(logs.some(m => /pass failed: boom/.test(m)));
  assert.equal(second.t.fn(), 'failed', 'the timer keeps working after a failure');
});

test('the lock keeps a second server out, and a crashed holder does not block forever', () => {
  const lockFile = join(dir(), 'l');
  assert.equal(acquireLock(lockFile), true);
  assert.equal(acquireLock(lockFile), false, 'a live holder (this process) excludes a second one');
  const { setTimer, clearTimer } = fakeTimers(); const logs = [];
  assert.equal(startReanalysisSchedule({}, { intervalMinutes: 5, lockFile, log: m => logs.push(m), setTimer, clearTimer }), null);
  assert.match(logs[0], /another server holds the lock/);
  writeFileSync(lockFile, '999999999');
  assert.equal(acquireLock(lockFile), true, 'a dead pid is cleared');
  writeFileSync(lockFile, 'not-a-pid');
  assert.equal(acquireLock(lockFile), true, 'a garbled lock is cleared');
});
