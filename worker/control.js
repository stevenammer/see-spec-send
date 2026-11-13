import { createHash } from 'node:crypto';
import { usdToMicros } from '../core/machine.js';
import { readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';

// Schema lives in core/schema.js and is created by the migration runner, not here.
export function attach(store, file) {
  // Resolve symbolic links so a database alias shares the independent stop latch.
  store.killFile = file && file !== ':memory:' ? `${realpathSync(file)}.kill` : null;
}

export function killed(store) {
  if (store.killFile) {
    try { readFileSync(store.killFile); return true; } catch (error) {
      if (error.code !== 'ENOENT') return true;
    }
  }
  return store.db.prepare('SELECT killed FROM worker_control WHERE id=1').get().killed === 1;
}

export function transaction(store, work) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

const reason = error => String(error?.message || error).slice(0, 200);

function writeKillRow(store, enabled) {
  transaction(store, () => {
    store.db.prepare('UPDATE worker_control SET killed=? WHERE id=1').run(enabled ? 1 : 0);
    if (enabled) store.db.prepare("UPDATE runs SET status='stop_requested' WHERE status='active'").run();
    store.db.prepare('INSERT INTO worker_history(action,at) VALUES(?,?)')
      .run(enabled ? 'kill.set' : 'kill.clear', new Date().toISOString());
  });
}

// Stops every builder container that has not finished. A container still running after kill
// and remove is recorded as stop_failed so an operator sees it instead of assuming it stopped.
export function stopBuilders(store, docker) {
  const rows = store.db.prepare("SELECT id,container_name,token_digest FROM container_jobs WHERE state IN ('queued','starting','running','stop_requested')").all();
  return rows.map(row => {
    let ok = false; let error = null;
    try {
      docker.kill(row.container_name);
      docker.remove(row.container_name);
      ok = !docker.inspect(row.container_name)?.State?.Running;
      if (!ok) error = 'container still running after kill';
    } catch (cause) { error = reason(cause); }
    if (row.token_digest) store.db.prepare('UPDATE gateway_capabilities SET revoked=1 WHERE digest=?').run(row.token_digest);
    store.db.prepare('UPDATE container_jobs SET state=?,error=? WHERE id=?')
      .run(ok ? 'stopped' : 'stop_failed', ok ? 'emergency stop' : error, row.id);
    return { id: row.id, name: row.container_name, ok, error };
  });
}

// Sets both latches and reports each one. A failed file write must not keep the database
// latch from being set, so each latch is attempted on its own and the caller decides.
export function setKill(store, enabled, { docker = null } = {}) {
  const report = { file: { ok: true }, database: { ok: true }, builders: [] };
  if (!enabled) {
    writeKillRow(store, false);
    if (store.killFile) {
      try { unlinkSync(store.killFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return report;
  }
  if (store.killFile) {
    try { writeFileSync(store.killFile, 'stop\n', { mode: 0o600 }); } catch (error) { report.file = { ok: false, error: reason(error) }; }
  }
  try { writeKillRow(store, true); } catch (error) { report.database = { ok: false, error: reason(error) }; }
  if (docker) report.builders = stopBuilders(store, docker);
  return report;
}

// Legacy charges and the new ledger share the original approval's cap.
function guardLedger(store, item, event) {
  if (event.type !== 'charged') return;
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='gateway_receipts'").get()) return;
  const context = store.read(item).context;
  const micros = usdToMicros(event.usd);
  if (micros === null) throw new Error('invalid usd');
  let held = 0n;
  const rows = store.db.prepare('SELECT * FROM gateway_receipts').all();
  const integrity = store.db.prepare('SELECT receipt_count FROM gateway_integrity WHERE id=1').get();
  if (!integrity || integrity.receipt_count !== rows.length) throw new Error('corrupt gateway receipt count');
  for (const row of rows) {
    const { seal, ...data } = row;
    const bytes = JSON.stringify(data, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
    if (seal !== createHash('sha256').update(bytes).digest('hex')
        || !Number.isSafeInteger(row.charged_micros) || row.charged_micros < 0) {
      throw new Error('corrupt gateway accounting');
    }
    if (row.item === item && row.approval === context.approval) held += BigInt(row.charged_micros);
  }
  if (held + BigInt(context.spentMicros) + BigInt(micros) > BigInt(context.capMicros)) {
    throw new Error('combined gateway and legacy cap exceeded');
  }
}

export function guard(store, item, event) {
  guardLedger(store, item, event);
  if (['tried', 'charged'].includes(event.type) && killed(store)) throw new Error('emergency kill is set');
  const run = store.db.prepare('SELECT * FROM runs WHERE run_actor=? OR gateway_actor=?').get(event.actor, event.actor);
  if (!run) return;
  if (run.item !== item || event.approval !== run.approval || event.spec_hash !== run.spec_hash) {
    throw new Error('run approval binding mismatch');
  }
  if (run.status === 'stopped' || (event.type !== 'failed' && run.status !== 'active')) {
    throw new Error('run is stopped');
  }
}
