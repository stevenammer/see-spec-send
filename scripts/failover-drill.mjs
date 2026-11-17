// Manual warm-standby drill. It needs loopback sockets, so it is separate from scripts/drill.sh.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';

const root = process.cwd(); const work = mkdtempSync(join(tmpdir(), 'sss-failover-')); const primary = join(work, 'primary.sqlite'); const replica = join(work, 'replica'); const promoted = join(work, 'promoted.sqlite');
const run = (db, ...args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd: root, env: { ...process.env, SSS_DB: db }, encoding: 'utf8' });
const port = 18888; const origin = `http://127.0.0.1:${port}`;
const waitReady = async () => { for (let end = Date.now() + 15_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) { try { if ((await fetch(`${origin}/readyz`)).status === 200) return true; } catch {} } return false; };
const serve = db => spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--host', '127.0.0.1', '--origin', origin, '--insecure-cookies'], { cwd: root, env: { ...process.env, SSS_DB: db }, stdio: 'ignore' });
const need = (condition, message) => { if (!condition) throw new Error(message); };

const initialized = run(primary, 'init', '--id', 'drill-leader'); need(initialized.status === 0, initialized.stderr);
let server = serve(primary); need(await waitReady(), 'primary did not become ready');
// Data is written through the store so the drill does not depend on the first-sign-in password change.
const write = (db, id, text) => { const store = new Store(db); try { store.append(id, { type: 'posted', actor: 'drill-leader', rules: 3, original: text, at: new Date().toISOString() }, { idem: id }); } finally { store.close(); } };
const items = db => { const store = new Store(db); try { return store.db.prepare('SELECT DISTINCT item FROM events').all().map(row => row.item); } finally { store.close(); } };
write(primary, 'before-backup', 'Synthetic item written before the backup.');
const copied = run(primary, 'replicate', '--to', replica, '--once'); need(copied.status === 0, copied.stderr);
write(primary, 'after-backup', 'Synthetic item written after the backup.');
server.kill('SIGKILL');
const started = Date.now(); const standby = run(primary, 'standby', '--from', replica, '--db', promoted, '--force'); need(standby.status === 0, standby.stderr);
need(run(promoted, 'kill', 'clear').status === 0, 'could not clear restored stop latch');
server = serve(promoted); need(await waitReady(), 'promoted server did not become ready');
const after = items(promoted);
need(after.length === 1 && after[0] === 'before-backup', `expected only before-backup data after promotion, found ${JSON.stringify(after)}`);
server.kill('SIGTERM');
console.log(JSON.stringify({ readyz: 'ok', before_backup_present: true, after_backup_lost: true, measured_rto_seconds: Number(((Date.now() - started) / 1000).toFixed(3)), measured_rpo_items_lost: 1 }));
