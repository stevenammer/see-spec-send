import { setKill, transaction } from './control.js';

// Fail closed. This is deliberately an operator control, not a scheduler.
export function inspectWatchdog(store, { now = Date.now(), heartbeatMs = 15_000, runMs = 15 * 60_000, outboxMs = 15 * 60_000 } = {}) {
  const heartbeat = store.db.prepare('SELECT at FROM worker_heartbeat WHERE id=1').get();
  const staleHeartbeat = !heartbeat || now - heartbeat.at > heartbeatMs;
  const staleRuns = store.db.prepare("SELECT id FROM runs WHERE status IN ('active','stop_requested') AND started_at IS NOT NULL AND ? - started_at > ?").all(now, runMs);
  const outbox = store.db.prepare("SELECT id FROM integration_outbox WHERE state IN ('dead','sending') AND ? - created > ?").all(now, outboxMs);
  return { staleHeartbeat, staleRuns: staleRuns.map(row => row.id), unrecoverableOutbox: outbox.map(row => row.id) };
}

export function watchdog(store, options = {}) {
  const found = inspectWatchdog(store, options);
  if (!found.staleHeartbeat && !found.staleRuns.length && !found.unrecoverableOutbox.length) return { stopped: false, ...found };
  setKill(store, true);
  transaction(store, () => store.db.prepare('INSERT INTO worker_history(action,at) VALUES(?,?)').run('watchdog.stop', new Date(options.now || Date.now()).toISOString()));
  return { stopped: true, ...found };
}
