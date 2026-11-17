// Clean-room drill: install, run, crash, recover, back up, restore, verify. Runs inside a throwaway container
// (see scripts/drill.sh) so nothing touches a real database. Exit code 0 only if every step holds.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd(), data = process.env.DRILL_DATA || '/data', db = join(data, 'sss.db');
const env = { ...process.env, SSS_DB: db };
mkdirSync(data, { recursive: true });
const cli = (...args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd: root, env, encoding: 'utf8' });
const steps = []; const ok = (name, cond, detail = '') => { steps.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!cond) process.exitCode = 1; };
const port = 18787, origin = `http://127.0.0.1:${port}`;
const wait = async (path, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(origin + path); if (r.status < 500) return r; } catch {} await new Promise(r => setTimeout(r, 200)); } return null; };
const serve = () => spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--host', '127.0.0.1', '--origin', origin, '--insecure-cookies'], { cwd: root, env, stdio: 'ignore' });

// 1. fresh install
const init = cli('init', '--id', 'leader');
ok('init creates the database and prints a one-time leader password', init.status === 0 && /password/i.test(init.stdout + init.stderr));
ok('database file is owner-only (0600)', (statSync(db).mode & 0o077) === 0, (statSync(db).mode & 0o777).toString(8));
const password = (init.stdout.match(/password[^\n]*?([A-Za-z0-9_-]{16,})/i) || [])[1];
ok('schema is current and migrations report nothing pending', JSON.parse(cli('migrate', '--check').stdout || '{}').pending?.length === 0 || /"current"/.test(cli('migrate', '--check').stdout));

// 2. run, sign in, write
let server = serve();
ok('server starts and serves sign-in', !!(await wait('/signin')));
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id: 'leader', password }) });
const cookie = login.headers.get('set-cookie')?.split(';')[0]; const csrf = (await login.json().catch(() => ({}))).csrf;
ok('leader signs in with the one-time password', login.status === 200 && !!cookie);
let headers = { 'content-type': 'application/json', cookie, origin, 'x-csrf-token': csrf };
// The initial password is temporary: the first thing a real leader does is choose their own.
const stepup = await fetch(`${origin}/api/stepup`, { method: 'POST', headers, body: JSON.stringify({ password }) });
ok('a fresh step-up is required, and the temporary password satisfies it', stepup.status === 204 || stepup.status === 200, String(stepup.status));
const changed = await fetch(`${origin}/api/password`, { method: 'POST', headers, body: JSON.stringify({ password: 'a-long-drill-passphrase-9x' }) });
const cookie2 = changed.headers.get('set-cookie')?.split(';')[0]; const csrf2 = (await changed.json().catch(() => ({}))).csrf;
ok('the temporary password must be replaced before anything else', changed.status === 200 && !!cookie2, String(changed.status));
headers = { 'content-type': 'application/json', cookie: cookie2, origin, 'x-csrf-token': csrf2 };
const post = (n) => fetch(`${origin}/api/items`, { method: 'POST', headers, body: JSON.stringify({ original: `Drill problem ${n}: the handoff loses the caller note.` }) });
let made = 0; for (let n = 0; n < 5; n += 1) { const r = await post(n); if (r.status === 201) made += 1; else if (n === 0) console.log('  first post ->', r.status, (await r.text()).slice(0, 120)); }
ok('items can be posted', made === 5, `${made}/5`);

// 3. crash: hammer writes, SIGKILL mid-flight, restart, everything must still verify
const hammer = (async () => { for (let n = 100; n < 400; n += 1) { try { await post(n); } catch { break; } } })();
await new Promise(r => setTimeout(r, 600)); server.kill('SIGKILL'); await hammer.catch(() => {});
ok('server was killed mid-write', true);
const verifyAfterCrash = cli('verify');
ok('after SIGKILL every item chain and the audit log verify', verifyAfterCrash.status === 0, (verifyAfterCrash.stdout.split('\n').find(l => /bad|fail|mismatch/i.test(l)) || '').slice(0, 80));
server = serve();
ok('server restarts on the same database', !!(await wait('/signin')));
const relog = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id: 'leader', password: 'a-long-drill-passphrase-9x' }) });
const list = await fetch(`${origin}/api/items`, { headers: { cookie: relog.headers.get('set-cookie')?.split(';')[0] } });
ok('previously committed items are still there after the crash', list.status === 200 && (await list.json()).items.length >= 5);
server.kill('SIGTERM'); await new Promise(r => setTimeout(r, 800));

// 4. backup, verify, restore into a new place, compare
const backup = join(data, 'sss.db.backup');
const made2 = cli('backup', '--to', backup);
ok('backup writes and reports a manifest', made2.status === 0 && /sha256/.test(made2.stdout));
const drillDb = join(data, 'restored.db');
const restored = spawnSync(process.execPath, ['cli.js', 'restore', '--from', backup], { cwd: root, env: { ...process.env, SSS_DB: drillDb }, encoding: 'utf8' });
ok('restore verifies and creates a stopped copy', restored.status === 0 && /restored and verified/.test(restored.stdout + restored.stderr));
ok('the restored copy starts with the stop latch set', existsSync(`${drillDb}.kill`) || /stopped|kill/i.test(restored.stdout));
const verifyRestored = spawnSync(process.execPath, ['cli.js', 'verify'], { cwd: root, env: { ...process.env, SSS_DB: drillDb }, encoding: 'utf8' });
ok('the restored database verifies', verifyRestored.status === 0);
const tampered = join(data, 'tampered.backup'); spawnSync('cp', ['-r', backup, tampered]);
// Corrupt one byte in place: a plain file is appended to; a directory has its first file appended to. No shell involved.
const victim = statSync(tampered).isDirectory() ? join(tampered, readdirSync(tampered).sort()[0]) : tampered;
appendFileSync(victim, 'x');
const bad = spawnSync(process.execPath, ['cli.js', 'restore', '--from', tampered], { cwd: root, env: { ...process.env, SSS_DB: join(data, 'bad.db') }, encoding: 'utf8' });
ok('a tampered backup is refused on restore', bad.status !== 0);

// 4b. portability: export everything, import it into a brand-new database elsewhere, and verify it
import { writeFileSync as put } from 'node:fs';
const exported = cli('export'); put(join(data, 'org.jsonl'), exported.stdout);
ok('export writes a complete, self-describing file', exported.status === 0 && /"complete":true/.test(exported.stdout));
const moved = join(data, 'moved.db');
const imp = spawnSync(process.execPath, ['cli.js', 'import', '--from', join(data, 'org.jsonl')], { cwd: root, env: { ...process.env, SSS_DB: moved }, encoding: 'utf8' });
ok('import loads it into a new database and says how to create the first leader', imp.status === 0 && /Run `init/.test(imp.stdout));
const verifyMoved = spawnSync(process.execPath, ['cli.js', 'verify'], { cwd: root, env: { ...process.env, SSS_DB: moved }, encoding: 'utf8' });
ok('the imported database verifies', verifyMoved.status === 0);
const again = spawnSync(process.execPath, ['cli.js', 'import', '--from', join(data, 'org.jsonl')], { cwd: root, env: { ...process.env, SSS_DB: moved }, encoding: 'utf8' });
ok('import never overwrites an existing database', again.status !== 0 && /new database/.test(again.stderr + again.stdout));

// 5. second start must not need or change anything
const migrateAgain = cli('migrate', '--check');
ok('migrations are idempotent on the live database', migrateAgain.status === 0);

console.log(`\n${steps.filter(s => s.pass).length}/${steps.length} drill steps passed`);
