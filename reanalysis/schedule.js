import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { runReanalysis } from './run.js';

// Runs reanalysis on a timer inside `serve`. Off unless an operator asks for it.
// Two guards keep it from doing harm: a real process lock (a second server on the
// same database never double-runs it) and a re-entrancy flag (a slow pass is never
// overlapped by the next tick). A failing pass is logged and the timer keeps going.
export const MIN_INTERVAL_MINUTES = 5, MAX_INTERVAL_MINUTES = 1440;

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const fd = openSync(file, 'wx', 0o600); writeSync(fd, String(process.pid)); closeSync(fd); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = NaN; try { owner = Number(readFileSync(file, 'utf8')); } catch {}
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) return false;
      try { unlinkSync(file); } catch {}   // a crashed holder: clear and retry once
    }
  }
  return false;
}

export function startReanalysisSchedule(store, { intervalMinutes, lockFile, clock = Date.now, log = () => {}, run = runReanalysis,
  setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES)
    throw new Error(`reanalysis interval must be ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes`);
  if (!lockFile || !acquireLock(lockFile)) { log('reanalysis scheduler not started: another server holds the lock'); return null; }
  let busy = false;
  const tick = () => {
    if (busy) return 'skipped';
    busy = true;
    try {
      const result = run(store, { now: new Date(clock()).toISOString() });
      log(`reanalysis: deltas=${result.deltas.length} annexes=${result.annexes.length} digest_entries=${result.delivery?.entries ?? 0}`);
      return 'ran';
    } catch (error) { log(`reanalysis pass failed: ${String(error.message).slice(0, 200)}`); return 'failed'; }
    finally { busy = false; }
  };
  const timer = setTimer(tick, intervalMinutes * 60_000); timer.unref?.();
  return { tick, stop() { clearTimer(timer); try { unlinkSync(lockFile); } catch {} } };
}
