// Daily reset for the hosted demo. Replaces the database with a fresh seed, with three guards:
//  1. It runs only between 00:00 and 00:10 UTC, unless --force is given.
//  2. It refuses a second reset in the same UTC day (--force does not lift this).
//  3. A forced reset outside the window sets the kill latch until the next UTC day, because a new database also
//     starts a new day's spend counter. The next scheduled reset clears a latch that this script set, and only that one.
// The clock is injected so tests never wait for midnight.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../core/store.js';
import { killed, setKill } from '../../worker/control.js';
import { seedDemo } from './seed.js';

export const WINDOW_MINUTES = 10;
export const utcDay = date => date.toISOString().slice(0, 10);
export const nextUtcDay = date => utcDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)));
export const inWindow = date => date.getUTCHours() === 0 && date.getUTCMinutes() < WINDOW_MINUTES;

const statePath = db => `${db}.reset-state.json`;
const killPath = db => `${db}.kill`;
const readState = db => { try { return JSON.parse(readFileSync(statePath(db), 'utf8')); } catch { return {}; } };

// Pure decision. Returns { ok, reason, midDay }.
export function decide({ now, force = false, state = {} }) {
  if (state.lastResetDay === utcDay(now)) return { ok: false, reason: `refused: already reset on ${state.lastResetDay} (UTC); one reset per UTC day` };
  const window = inWindow(now);
  if (!window && !force) return { ok: false, reason: `refused: ${now.toISOString()} is outside 00:00 to 00:10 UTC; use --force only for an emergency (it sets the kill latch until the next UTC day)` };
  return { ok: true, midDay: !window, reason: window ? 'in window' : 'forced outside window' };
}

// check: decide only, touch nothing. The wrapper script calls this before it stops the app, so a refusal costs no downtime.
export function runReset({ db, now = () => new Date(), force = false, check = false, init = false, seed = seedDemo, log = () => {} }) {
  const moment = now();
  if (init) {
    // First install only: there is no earlier database, so no spend counter is being wiped and no guard applies.
    if (existsSync(db)) return { done: false, reason: 'refused: --init is for a first install; a database already exists' };
    if (check) return { done: false, check: true, ok: true, reason: 'first install' };
    seed(db, { now: moment }); log('seeded a new demo database');
    return { done: true, ok: true, reason: 'first install', killed: false };
  }
  const state = readState(db);
  const verdict = decide({ now: moment, force, state });
  if (!verdict.ok) return { done: false, ...verdict };
  if (check) return { done: false, check: true, ...verdict };

  const today = utcDay(moment);
  const latchFile = killPath(db);
  const wasLatched = existsSync(latchFile);
  // A latch this script set for an earlier day is cleared once that day has come. Any other latch (the owner's own) is kept.
  const ownLatchExpired = Boolean(state.killUntilDay) && state.killUntilDay <= today;
  const carryLatch = wasLatched && !(ownLatchExpired && state.killSetByReset);
  const keepUntil = state.killUntilDay && state.killUntilDay > today ? state.killUntilDay : null;

  // Build the new database beside the old one, then swap. A failed seed leaves the old database untouched.
  const fresh = `${db}.seed`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${fresh}${suffix}`, { force: true });
  seed(fresh, { now: moment });
  for (const suffix of ['-wal', '-shm']) rmSync(`${db}${suffix}`, { force: true });
  renameSync(fresh, db);
  for (const suffix of ['-wal', '-shm']) rmSync(`${fresh}${suffix}`, { force: true });
  rmSync(latchFile, { force: true });

  const next = { lastResetDay: today };
  if (verdict.midDay) {
    next.killUntilDay = nextUtcDay(moment);
    // If the owner had already latched it, the owner's latch stays theirs and survives the next reset.
    next.killSetByReset = !(wasLatched && !state.killSetByReset);
  } else if (carryLatch) {
    if (keepUntil) { next.killUntilDay = keepUntil; next.killSetByReset = Boolean(state.killSetByReset); }
  }
  if (verdict.midDay || carryLatch) {
    const store = new Store(db);
    try { const report = setKill(store, true); if (!report.file.ok || !report.database.ok) throw new Error('could not set the kill latch after reset'); } finally { store.close(); }
  }
  writeFileSync(statePath(db), JSON.stringify(next) + '\n', { mode: 0o600 });
  log(`reset ${today}: ${verdict.reason}; kill latch ${verdict.midDay || carryLatch ? `set until ${next.killUntilDay ?? 'cleared by owner'}` : 'clear'}`);
  return { done: true, ...verdict, killed: verdict.midDay || carryLatch, state: next };
}

export function latchStatus(db) {
  if (!existsSync(db)) return 'no database';
  const store = new Store(db);
  try { return killed(store) ? 'stopped' : 'clear'; } finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const db = process.env.SSS_DB || join(dirname(fileURLToPath(import.meta.url)), 'sss.db');
  try {
    const result = runReset({ db, force: args.includes('--force'), init: args.includes('--init'), check: args.includes('--check'), log: message => console.log(message) });
    if (!result.done && !result.check) { console.error(result.reason); process.exitCode = 3; }
    else if (result.check) console.log(`ok to reset: ${result.reason}`);
  } catch (error) { console.error(`reset failed: ${error.message}`); process.exitCode = 1; }
}
