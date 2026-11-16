// Load test against a real server on a temporary database. Synthetic users doing a realistic mix.
//   node scripts/load.mjs [--users 5] [--workers-per-user 4] [--seconds 20] [--seed-items 300]
// Sign-in is rate limited per address, so concurrency comes from several workers sharing each signed-in user.
// It reports latency percentiles per operation, error rates, and how long a reanalysis pass takes at the seeded size.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { runReanalysis } from '../reanalysis/run.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const USERS = arg('users', 5), WORKERS = arg('workers-per-user', 4), SECONDS = arg('seconds', 20), SEED = arg('seed-items', 300);
const dir = mkdtempSync(join(tmpdir(), 'sss-load-')), file = join(dir, 'sss.db');
const password = 'a-long-load-test-passphrase-9x';

// Seed: users and a body of history, written directly so the setup is not part of the measurement.
const store = new Store(file); const auth = new Auth(store);
const people = Array.from({ length: USERS }, (_, i) => `user${i}`);
for (const id of people) await auth.createUser(id, password, false);
await auth.createUser('lead', password, true);
const stamp = '2026-11-10T12:00:00.000Z'; let n = 0;
const add = (item, event) => store.append(item, { ...event, at: stamp }, { idem: `seed-${++n}` });
const bind = item => ({ post_id: store.read(item).context.activePost?.id, post_version: store.read(item).context.activePost?.version });
const topics = ['integration', 'export permission', 'caller note', 'night shift', 'handoff checklist', 'transfer screen', 'spanish queue', 'audio storage'];
const seedStart = Date.now();
for (let i = 0; i < SEED; i += 1) {
  const item = `seed${i}`, author = people[i % USERS], topic = topics[i % topics.length];
  add(item, { type: 'posted', actor: author, original: `The ${topic} problem number ${i} loses context at handoff.`, rules: 3 });
  if (i % 3 === 0) {
    add(item, { type: 'specced', actor: author, see_hash: store.read(item).context.seeHash, must: ['Keep the note'], how_we_know: ['It appears'], out_of_scope: [], assumptions: [`The ${topic} needs a new integration to carry the note.`], open_questions: [], ...bind(item) });
    const spec = store.read(item).context.specHash, packet = store.putArtifact(item, JSON.stringify({ specHash: spec }));
    add(item, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(item) });
    if (i % 6 === 0) add(item, { type: 'decided', actor: 'lead', disposition: 'decline', reason_code: 'budget', reason: `No budget for the ${topic} integration this quarter.`, metadata: {}, spec_hash: spec, packet_hash: packet, ...bind(item) });
  }
}
const seedMs = Date.now() - seedStart;
const pass0 = Date.now(); const first = runReanalysis(store, { now: '2026-11-16T12:00:00.000Z', limit: 500 }); const reanalysisMs = Date.now() - pass0;
const pass1 = Date.now(); runReanalysis(store, { now: '2026-11-16T12:00:00.000Z', limit: 500 }); const reanalysisIdleMs = Date.now() - pass1;
store.close();

const port = 19000 + Math.floor(Math.random() * 500), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [...(process.env.LOAD_NODE_ARGS ? process.env.LOAD_NODE_ARGS.split(' ') : []), 'cli.js', 'serve', '--port', String(port), '--host', '127.0.0.1', '--origin', origin, '--insecure-cookies'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, SSS_DB: file }, stdio: 'ignore' });
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${origin}/signin`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const samples = new Map(); const errors = new Map(); let total = 0;
const record = (op, ms, status) => { total += 1; (samples.get(op) || samples.set(op, []).get(op)).push(ms); if (status >= 400) errors.set(`${op} ${status}`, (errors.get(`${op} ${status}`) || 0) + 1); };
const timed = async (op, fn) => { const t = performance.now(); let status = 0; try { const r = await fn(); status = r.status; await r.arrayBuffer(); } catch { status = 599; } record(op, performance.now() - t, status); return status; };

const loginStart = Date.now();
const sessions = await Promise.all(people.map(async id => { const r = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id, password }) });
  const cookie = r.headers.get('set-cookie')?.split(';')[0], csrf = (await r.json().catch(() => ({}))).csrf; return { id, cookie, csrf }; }));
const loginMs = Date.now() - loginStart;
const live = sessions.filter(s => s.cookie);

const deadline = Date.now() + SECONDS * 1000;
async function worker(session, index) {
  const h = { 'content-type': 'application/json', cookie: session.cookie, origin, 'x-csrf-token': session.csrf };
  let mine = 0;
  while (Date.now() < deadline) {
    const roll = (index * 7 + mine) % 10; mine += 1;
    if (roll < 3) await timed('feed', () => fetch(`${origin}/`, { headers: { cookie: session.cookie } }));
    else if (roll < 5) await timed('item page', () => fetch(`${origin}/items/seed${(index * 13 + mine) % SEED}`, { headers: { cookie: session.cookie } }));
    else if (roll < 6) await timed('search', () => fetch(`${origin}/search?q=handoff`, { headers: { cookie: session.cookie } }));
    else if (roll < 8) await timed('post SEE', () => fetch(`${origin}/api/items`, { method: 'POST', headers: h, body: JSON.stringify({ original: `Load problem from ${session.id} number ${mine}: the handoff loses the note.` }) }));
    else if (roll < 9) await timed('api items', () => fetch(`${origin}/api/items`, { headers: { cookie: session.cookie } }));
    else await timed('knowledge', () => fetch(`${origin}/knowledge?q=integration`, { headers: { cookie: session.cookie } }));
  }
}
const start = Date.now();
await Promise.all(live.flatMap((session, index) => Array.from({ length: WORKERS }, (_, w) => worker(session, index * 17 + w * 3))));
const elapsed = (Date.now() - start) / 1000;
server.kill('SIGTERM');

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
console.log(JSON.stringify({ users: live.length, concurrent_workers: live.length * WORKERS, seconds: Math.round(elapsed), seeded_items: SEED, seeded_in_ms: seedMs, login_all_ms: loginMs,
  reanalysis_first_pass_ms: reanalysisMs, reanalysis_idle_pass_ms: reanalysisIdleMs, annexes_first_pass: first.annexes.length,
  requests: total, rps: Number((total / elapsed).toFixed(1)) }));
for (const [op, arr] of [...samples].sort()) console.log(`${op.padEnd(10)} n=${String(arr.length).padStart(5)}  p50=${pct(arr, 0.5).toFixed(0).padStart(5)}ms  p95=${pct(arr, 0.95).toFixed(0).padStart(5)}ms  p99=${pct(arr, 0.99).toFixed(0).padStart(5)}ms  max=${Math.max(...arr).toFixed(0).padStart(5)}ms`);
console.log('errors:', errors.size ? Object.fromEntries(errors) : 'none');
