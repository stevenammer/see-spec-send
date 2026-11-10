import { readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';

export function setup(store, file) {
  // Resolve symbolic links so a database alias shares the independent stop latch.
  store.killFile = file && file !== ':memory:' ? `${realpathSync(file)}.kill` : null;
  store.db.exec(`CREATE TABLE IF NOT EXISTS worker_control(id INTEGER PRIMARY KEY CHECK(id=1), killed INTEGER NOT NULL);
    INSERT OR IGNORE INTO worker_control VALUES(1,0);
    CREATE TABLE IF NOT EXISTS worker_history(seq INTEGER PRIMARY KEY, action TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, item TEXT NOT NULL, approval INTEGER NOT NULL, spec_hash TEXT NOT NULL,
      run_actor TEXT UNIQUE NOT NULL, gateway_actor TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(item,approval)
    );
    CREATE TABLE IF NOT EXISTS fake_jobs(id TEXT PRIMARY KEY, input TEXT NOT NULL, html TEXT NOT NULL, status TEXT NOT NULL);`);
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

export function setKill(store, enabled) {
  // Set the independent latch first. A failed database write must still stop delivery.
  if (enabled && store.killFile) writeFileSync(store.killFile, 'stop\n', { mode: 0o600 });
  transaction(store, () => {
    store.db.prepare('UPDATE worker_control SET killed=? WHERE id=1').run(enabled ? 1 : 0);
    if (enabled) store.db.prepare("UPDATE runs SET status='stop_requested' WHERE status='active'").run();
    store.db.prepare('INSERT INTO worker_history(action,at) VALUES(?,?)')
      .run(enabled ? 'kill.set' : 'kill.clear', new Date().toISOString());
  });
  if (!enabled && store.killFile) {
    try { unlinkSync(store.killFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function guard(store, item, event) {
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
