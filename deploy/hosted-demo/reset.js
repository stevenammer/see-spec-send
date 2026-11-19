// Daily reset for the hosted demo. Replaces the database with a fresh seed, with three guards:
//  1. It runs only between 00:00 and 00:10 UTC, unless --force is given.
//  2. It refuses a second reset in the same UTC day (--force does not lift this).
//  3. A forced reset outside the window sets the kill latch until the next UTC day, because a new database also
//     starts a new day's spend counter. The next scheduled reset clears a latch that this script set, and only that one.
//  4. The money ledger survives. Every gateway_* table (policy, policy versions, receipts, integrity count, hold audit and the
//     Quest, Effort and analysis receipts) is copied from the old database into the fresh seed before the swap, so the lifetime
//     cap (global_micros), the per-person counters and the policy keep bounding spend across resets. Everything else is replaced.
//     Builder-lane receipts (gateway_receipts) are bound to a run and an approval event that the reset deletes, so a verbatim copy would
//     fail the gateway's own binding check and stop every lane. They are rolled up instead, one sealed row per day, into
//     gateway_analysis_receipts under the person "reset-carry" (state settled, charged = the sum). Day and lifetime totals are unchanged.
//     The Quest, Effort and analysis receipts are self-contained and are copied verbatim, seals and all.
//     gateway_capabilities is NOT carried: those are run tokens for runs that the reset deletes, and a token must not outlive its run.
// The clock is injected so tests never wait for midnight.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../core/store.js';
import { Ledger, canonical, digest } from '../../gateway/ledger.js';
import { killed, setKill } from '../../worker/control.js';
import { seedDemo } from './seed.js';

export const WINDOW_MINUTES = 10;
export const utcDay = date => date.toISOString().slice(0, 10);
export const nextUtcDay = date => utcDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)));
export const inWindow = date => date.getUTCHours() === 0 && date.getUTCMinutes() < WINDOW_MINUTES;

const statePath = db => `${db}.reset-state.json`;
const killPath = db => `${db}.kill`;
const readState = db => { try { return JSON.parse(readFileSync(statePath(db), 'utf8')); } catch { return {}; } };

const NOT_CARRIED = new Set(['gateway_capabilities']);
const ROLLED_UP = new Set(['gateway_receipts', 'gateway_hold_audit', 'gateway_integrity']);   // see the header: replaced by one summary row per day
const sealOf = row => { const { seal, ...data } = row; return digest(canonical(data)); };
const ledgerTables = (db, schema) => db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name LIKE 'gateway\\_%' ESCAPE '\\' ORDER BY name`).all().map(row => row.name);
const columnsOf = (db, schema, table) => db.prepare(`SELECT name FROM pragma_table_info(?, ?) ORDER BY cid`).all(table, schema).map(row => row.name);

// Inside the caller's transaction. Verifies each old builder receipt's own seal, then writes one sealed analysis-table row per day.
function rollUpBuilderReceipts(db, stamp) {
  if (!ledgerTables(db, 'old').includes('gateway_receipts')) return 0;
  const rows = db.prepare('SELECT * FROM old.gateway_receipts ORDER BY id').all();
  if (rows.length === 0) return 0;
  for (const row of rows) if (row.seal !== sealOf(row)) throw new Error('corrupt gateway receipt checksum in the old database; not carrying it');
  const policy = db.prepare('SELECT bytes FROM main.gateway_policy WHERE id=1').get()?.bytes;
  if (!policy) throw new Error('no gateway policy to seal the carried totals under');
  const days = new Map();
  for (const row of rows) { const group = days.get(row.day) ?? { micros: 0, ids: [] }; group.micros += row.charged_micros; group.ids.push(row.id); days.set(row.day, group); }
  const insert = db.prepare(`INSERT INTO main.gateway_analysis_receipts(id,person,idem,payload_hash,policy,day,input_bound,output_bound,worst_micros,charged_micros,state,usage,outcome,seal,job_class)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [day, group] of [...days].sort()) {
    const person = 'reset-carry'; const idem = `carry-${day}-${stamp}`;
    const row = { id: digest(canonical(['analysis', person, idem])), person, idem, payload_hash: digest(canonical(group.ids)), policy, day,
      input_bound: 0, output_bound: 0, worst_micros: group.micros, charged_micros: group.micros, state: 'settled',
      usage: canonical({ input_tokens: 0, output_tokens: 0 }), outcome: canonical({ output: `carried forward: ${group.ids.length} builder receipts for ${day}` }), job_class: 'analysis' };
    row.seal = sealOf(row);
    insert.run(...['id', 'person', 'idem', 'payload_hash', 'policy', 'day', 'input_bound', 'output_bound', 'worst_micros', 'charged_micros', 'state', 'usage', 'outcome', 'seal', 'job_class'].map(key => row[key]));
  }
  return days.size;
}

// Copies the money ledger from the old database into the fresh seed, in one transaction, then proves the copy. Any throw
// leaves the old database untouched (it is only read) and the caller discards the fresh file.
export function carryLedger({ fresh, old, stamp = 'reset', afterTable = () => {} }) {
  const db = new DatabaseSync(fresh);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    db.prepare('ATTACH DATABASE ? AS old').run(old);
    const present = new Set(ledgerTables(db, 'main'));
    const copied = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ledgerTables(db, 'old')) {
        if (NOT_CARRIED.has(table) || ROLLED_UP.has(table)) continue;
        if (!present.has(table)) throw new Error(`ledger table ${table} is in the old database but not in the new schema`);
        const rows = db.prepare(`SELECT count(*) n FROM old.${table}`).get().n;
        if (rows === 0) continue;                       // nothing to carry: keep the seed's own (the fixture policy, a zero count)
        const oldCols = columnsOf(db, 'old', table); const newCols = columnsOf(db, 'main', table);
        if (oldCols.join() !== newCols.join()) throw new Error(`ledger table ${table} changed shape; refusing to carry it`);
        db.exec(`DELETE FROM main.${table}`);
        db.exec(`INSERT INTO main.${table}(${newCols.join(',')}) SELECT ${newCols.join(',')} FROM old.${table}`);
        if (db.prepare(`SELECT count(*) n FROM main.${table}`).get().n !== rows) throw new Error(`ledger table ${table} copied short`);
        copied.push(table); afterTable(table);
      }
      const rolled = rollUpBuilderReceipts(db, stamp);
      if (rolled) { copied.push(`gateway_receipts (rolled up into ${rolled} daily carry rows)`); afterTable('gateway_receipts'); }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
    db.exec('DETACH DATABASE old');
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0].integrity_check !== 'ok') throw new Error('new database failed integrity_check');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return copied;
  } finally { db.close(); }
}

// Opens the fresh file through the gateway code and re-verifies every seal and count, so a tampered or short copy is caught before the swap.
function verifyLedger(file) {
  const store = new Store(file);
  try { const ledger = new Ledger(store); ledger.policy(); ledger.policyVersions(); ledger.allMeteredReceipts(); ledger.holdAudits(); }
  finally { store.close(); }
}

// Pure decision. Returns { ok, reason, midDay }.
export function decide({ now, force = false, state = {} }) {
  if (state.lastResetDay === utcDay(now)) return { ok: false, reason: `refused: already reset on ${state.lastResetDay} (UTC); one reset per UTC day` };
  const window = inWindow(now);
  if (!window && !force) return { ok: false, reason: `refused: ${now.toISOString()} is outside 00:00 to 00:10 UTC; use --force only for an emergency (it sets the kill latch until the next UTC day)` };
  return { ok: true, midDay: !window, reason: window ? 'in window' : 'forced outside window' };
}

// check: decide only, touch nothing. The wrapper script calls this before it stops the app, so a refusal costs no downtime.
export function runReset({ db, now = () => new Date(), force = false, check = false, init = false, seed = seedDemo, log = () => {}, afterTable }) {
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
  try {
    seed(fresh, { now: moment });
    const carried = carryLedger({ fresh, old: db, stamp: moment.toISOString().replace(/\D/g, '').slice(0, 14), afterTable });
    verifyLedger(fresh);
    log(`carried the money ledger over: ${carried.length ? carried.join(', ') : 'nothing to carry (empty ledger)'}`);
  } catch (error) { for (const suffix of ['', '-wal', '-shm']) rmSync(`${fresh}${suffix}`, { force: true }); throw error; }
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
