// One real child process in the slice 22 soak. It opens the shared database file itself and
// never listens on a socket: the handler role drives the in-process request handler.
import { Readable } from 'node:stream';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../core/store.js';
import { Auth } from '../../app/auth.js';
import { createHandler } from '../../app/http.js';
import { writeBackup } from '../../core/backup.js';
import { Worker } from '../../worker/runner.js';
import { watchdog } from '../../worker/watchdog.js';

const [role, file, durationMs, directory] = process.argv.slice(2);
const until = Date.now() + Number(durationMs);
const stats = { role, ops: 0, ok: 0, busy: 0, refused: 0, lockErrors: 0, otherErrors: 0, stopped: false, firstError: '' };
const lock = error => error?.errcode === 5 || error?.errcode === 6 || /database (table )?is locked/.test(error?.message || '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fault = error => {
  if (lock(error)) stats.lockErrors += 1; else stats.otherErrors += 1;
  stats.firstError ||= String(error?.message || error).slice(0, 200);
};
const store = new Store(file);

class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function request(handler, method, path, input, headers) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path;
  req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response();
  await handler(req, res);
  return res;
}

if (role === 'handler') {
  const auth = new Auth(store);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://127.0.0.1' });
  const members = [];
  for (let n = 0; n < 4; n += 1) members.push(await auth.login(`member${n}`, process.env.SOAK_PASSWORD, '127.0.0.1'));
  for (let n = 0; Date.now() < until; n += 1) {
    const member = members[n % members.length];
    const headers = { cookie: `sss=${member.value}`, origin: 'http://127.0.0.1', 'x-csrf-token': member.csrf };
    try {
      const response = await request(handler, 'POST', '/api/items', { problem: `soak ${n}`, have: true, have_note: 'looked', verdict: 'build_needed' }, headers);
      stats.ops += 1;
      if (response.status === 201) stats.ok += 1;
      else if (response.status === 429) stats.refused += 1;
      else if (response.status === 503) { stats.busy += 1; stats.firstError ||= `503 ${response.text}`; }
      else stats.otherErrors += 1;
      if (n % 10 === 0) await request(handler, 'GET', '/api/items', undefined, headers);
      if (n % 25 === 0) await request(handler, 'GET', '/', undefined, headers);
    } catch (error) { fault(error); }
    await pause(5);
  }
} else if (role === 'worker') {
  const worker = new Worker(store);
  while (Date.now() < until) {
    try { worker.reconcile(); stats.ops += 1; } catch (error) { fault(error); }
    await pause(10);
  }
} else if (role === 'watchdog') {
  const docker = { kill() {}, remove() {}, inspect() { return { State: { Running: false } }; } };
  while (Date.now() < until) {
    try { stats.stopped ||= watchdog(store, { docker }).stopped; stats.ops += 1; } catch (error) { fault(error); }
    await pause(20);
  }
} else if (role === 'backup') {
  for (let n = 0; Date.now() < until; n += 1) {
    const target = join(directory, `backup-${n}.sqlite`);
    try { writeBackup(store, target); stats.ops += 1; } catch (error) { fault(error); } finally {
      rmSync(target, { force: true }); rmSync(`${target}.manifest.json`, { force: true });
    }
    await pause(50);
  }
} else {
  throw new Error(`unknown role ${role}`);
}
store.close();
console.log(JSON.stringify(stats));
