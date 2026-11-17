// Manual streaming-replication drill (Litestream in Docker). Needs a local Docker daemon and loopback sockets, so it
// is separate from `npm test`:   npm run test:failover-stream
// It runs a real server on a database that Litestream replicates, writes one item and waits, writes a second item and
// kills everything at once, deletes the primary's data, restores from the replica and starts a server on the result.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';

const root = process.cwd();
const image = readFileSync(join(root, 'deploy/litestream.digest'), 'utf8').trim();
const work = mkdtempSync(join(tmpdir(), 'sss-stream-')); chmodSync(work, 0o755);
const data = join(work, 'data'), replica = join(work, 'replica'), restored = join(work, 'restored');
for (const dir of [data, replica, restored]) mkdirSync(dir, { mode: 0o777 }), chmodSync(dir, 0o777);
writeFileSync(join(work, 'litestream.yml'), readFileSync(join(root, 'deploy/litestream.yml'), 'utf8'));
const primary = join(data, 'sss.db'), name = `sss-stream-drill-${process.pid}`;
const user = `${process.getuid()}:${process.getgid()}`;
const run = (db, ...args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd: root, env: { ...process.env, SSS_DB: db }, encoding: 'utf8' });
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const port = 18889, origin = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitReady = async () => { for (let end = Date.now() + 15_000; Date.now() < end; await sleep(100)) { try { if ((await fetch(`${origin}/readyz`)).status === 200) return true; } catch {} } return false; };
const serve = db => spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--host', '127.0.0.1', '--origin', origin, '--insecure-cookies'], { cwd: root, env: { ...process.env, SSS_DB: db }, stdio: 'ignore' });
const need = (condition, message) => { if (!condition) throw new Error(message); };
const write = (db, id, text) => { const store = new Store(db); try { store.append(id, { type: 'posted', actor: 'drill-leader', rules: 3, original: text, at: new Date().toISOString() }, { idem: id }); } finally { store.close(); } };
const items = db => { const store = new Store(db); try { return store.db.prepare('SELECT DISTINCT item FROM events').all().map(row => row.item).sort(); } finally { store.close(); } };

let server;
try {
  need(docker('version').status === 0, 'Docker is not available');
  need(run(primary, 'init', '--id', 'drill-leader').status === 0, 'init failed');
  server = serve(primary); need(await waitReady(), 'primary did not become ready');
  const started = docker('run', '-d', '--name', name, '--user', user, '--read-only', '-v', `${data}:/data`, '-v', `${replica}:/replica`, '-v', `${join(work, 'litestream.yml')}:/etc/litestream.yml:ro`, image, 'replicate');
  need(started.status === 0, started.stderr);
  for (let end = Date.now() + 20_000; !existsSync(join(replica, 'sss', 'generations')) || !readdirSync(join(replica, 'sss', 'generations')).length; await sleep(250)) need(Date.now() < end, 'Litestream never created a replica generation');
  write(primary, 'replicated', 'Synthetic item, then a pause long enough to replicate.');
  await sleep(3000);
  write(primary, 'two-and-a-half-seconds', 'Synthetic item written 2.5 seconds before the kill.');
  await sleep(2500);
  write(primary, 'last-second', 'Synthetic item written, then everything is killed immediately.');
  const failed = Date.now();
  server.kill('SIGKILL'); docker('kill', name);
  rmSync(primary, { force: true }); rmSync(`${primary}-wal`, { force: true }); rmSync(`${primary}-shm`, { force: true });
  const restore = docker('run', '--rm', '--user', user, '-v', `${replica}:/replica`, '-v', `${restored}:/restore`, image, 'restore', '-o', '/restore/sss.db', 'file:///replica/sss');
  need(restore.status === 0, `restore failed: ${restore.stderr}`);
  const promoted = join(restored, 'sss.db');
  const cleared = run(promoted, 'kill', 'clear'); need(cleared.status === 0, 'could not clear the restored stop latch');
  server = serve(promoted); need(await waitReady(), 'restored server did not become ready');
  const rto = Number(((Date.now() - failed) / 1000).toFixed(3));
  const after = items(promoted);
  need(after.includes('replicated'), `the replicated item is missing after restore: ${JSON.stringify(after)}`);
  need(after.includes('two-and-a-half-seconds'), `an item written 2.5 seconds before the kill is missing: ${JSON.stringify(after)}`);
  const lost = after.includes('last-second') ? 0 : 1;
  console.log(JSON.stringify({ readyz: 'ok', replicated_item_present: true, measured_rto_seconds: rto, last_second_item_lost: lost === 1, measured_rpo_items_lost: lost, window_seconds_survived: 2.5, note: 'an item written 2.5 seconds before the kill survived; one written instantly before it may be lost' }));
} finally {
  server?.kill('SIGTERM'); docker('rm', '-f', name);
  rmSync(work, { recursive: true, force: true });
}
