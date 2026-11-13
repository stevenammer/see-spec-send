import { setKill, transaction } from './control.js';
import { DockerCli } from './container.js';
import { recoverStaleSending } from '../app/integrations.js';

// Fail closed. This is deliberately an operator control, not a scheduler.
export function inspectWatchdog(store, { now = Date.now(), heartbeatMs = 15_000, runMs = 15 * 60_000, outboxMs = 15 * 60_000 } = {}) {
  const heartbeat = store.db.prepare('SELECT at FROM worker_heartbeat WHERE id=1').get();
  // A missing or old heartbeat only matters while work is in flight. A fresh install with no run is not an emergency.
  const inFlight = store.db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('active','stop_requested')").get().n;
  const staleHeartbeat = inFlight > 0 && (!heartbeat || now - heartbeat.at > heartbeatMs);
  const staleRuns = store.db.prepare("SELECT id FROM runs WHERE status IN ('active','stop_requested') AND started_at IS NOT NULL AND ? - started_at > ?").all(now, runMs);
  // A "sending" row is not an emergency. It returns to pending when its lease lapses.
  const outbox = store.db.prepare("SELECT id FROM integration_outbox WHERE state = 'dead' AND ? - created > ?").all(now, outboxMs);
  return { staleHeartbeat, staleRuns: staleRuns.map(row => row.id), unrecoverableOutbox: outbox.map(row => row.id) };
}

// A dead outbox row is one customer's broken destination. It raises an alert, once per row, and never stops the install.
// One key per stale row. Keys are remembered in worker_history, so clearing the stop does not
// re-fire for rows the watchdog already acted on. A new row, or a new heartbeat, is a new incident.
function incidentKeys(store, found) {
  const keys = [];
  if (found.staleHeartbeat) {
    const heartbeat = store.db.prepare('SELECT at FROM worker_heartbeat WHERE id=1').get();
    keys.push(`heartbeat:${heartbeat ? heartbeat.at : 'none'}`);
  }
  for (const id of found.staleRuns) keys.push(`run:${id}`);
  return keys;
}

export function watchdog(store, options = {}) {
  const now = options.now ?? Date.now();
  const docker = options.docker ?? new DockerCli();
  const recovered = recoverStaleSending(store, now);
  const found = inspectWatchdog(store, { ...options, now });
  const seen = new Set(store.db.prepare("SELECT action FROM worker_history WHERE action LIKE 'watchdog.seen:%'").all()
    .map(row => row.action.slice('watchdog.seen:'.length)));
  const known = new Set(store.db.prepare("SELECT action FROM worker_history WHERE action LIKE 'watchdog.alert:outbox:%'").all().map(row => row.action));
  const alerted = found.unrecoverableOutbox.filter(id => !known.has(`watchdog.alert:outbox:${id}`));
  for (const id of alerted) store.db.prepare('INSERT INTO worker_history(action,at) VALUES(?,?)').run(`watchdog.alert:outbox:${id}`, new Date(now).toISOString());
  const fresh = incidentKeys(store, found).filter(key => !seen.has(key));
  if (!fresh.length) return { stopped: false, ...found, recovered, alerted };
  const report = setKill(store, true, { docker });
  // Only a stop that really latched is recorded as acted on. A failed latch is retried on the next tick.
  if (!report.file.ok || !report.database.ok) throw Error(`watchdog could not set the emergency stop: ${report.file.error || report.database.error}`);
  transaction(store, () => {
    const at = new Date(now).toISOString();
    const insert = store.db.prepare('INSERT INTO worker_history(action,at) VALUES(?,?)');
    insert.run('watchdog.stop', at);
    for (const key of fresh) insert.run(`watchdog.seen:${key}`, at);
  });
  return { stopped: true, ...found, recovered, alerted, builders: report.builders };
}
