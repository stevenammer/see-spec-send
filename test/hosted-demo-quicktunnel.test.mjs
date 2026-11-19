import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createServerFor } from '../app/http.js';

const dir = new URL('../deploy/hosted-demo/', import.meta.url).pathname;
const read = name => readFileSync(join(dir, name), 'utf8');

test('quick-tunnel compose: hardened, no token, no published ports, shared namespace, no docker socket', () => {
  const quick = read('compose.quicktunnel.yaml').split('\n').filter(line => !/^\s*#/.test(line)).map(line => line.replace(/\s+#.*$/, '')).join('\n'); const token = read('compose.yaml');
  assert.doesNotMatch(quick, /TUNNEL_TOKEN|env_file|^\s*ports:|docker\.sock|network_mode: "?host|privileged|cap_add/m);
  assert.match(quick, /\[ALL\]/); assert.match(quick, /no-new-privileges:true/); assert.match(quick, /read_only: true/);
  assert.match(quick, /"--no-autoupdate", "--metrics", "127\.0\.0\.1:20241", "--url", "http:\/\/localhost:8080"/);
  assert.match(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'), /ENTRYPOINT .*--trusted-proxy/);   // the app container's entrypoint; compose only appends
  assert.doesNotMatch(quick, /insecure-cookies/);
  // Same pinned cloudflared digest as the token variant, and no unpinned fallback.
  const digest = text => text.match(/cloudflare\/cloudflared@sha256:[0-9a-f]{64}/)?.[0];
  assert.ok(digest(quick)); assert.equal(digest(quick), digest(token));
  // app and cloudflared both join the holder, so restarting the app never restarts the tunnel.
  assert.equal(quick.match(/network_mode: "service:netns"/g).length, 2);
  assert.match(quick, /--fixture/); assert.doesNotMatch(quick, /--oidc-config|provider/);
  // The token variant is unchanged in the ways that matter.
  assert.match(token, /network_mode: "service:app"/); assert.match(token, /env_file: \.\/tunnel\.env/);
});

const tunnel = (env, ...args) => spawnSync('sh', [join(dir, 'tunnel-url.sh'), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('tunnel-url.sh: accepts only a strict trycloudflare hostname, writes the file, rewrites origin, signals change', () => {
  const work = mkdtempSync(join(tmpdir(), 'sss-qt-')); const out = join(work, 'url.txt'); const envFile = join(work, 'demo.env');
  writeFileSync(envFile, 'SSS_MODE=quicktunnel\nSSS_ORIGIN=https://old.trycloudflare.com\n');
  const run = (source, ...args) => tunnel({ SSS_URL_FILE: out, SSS_TUNNEL_SOURCE_CMD: source }, ...args);

  let r = run('echo \'{"x":1}\' >/dev/null; echo quiet-sky-1234.trycloudflare.com', '--set-origin', envFile);
  assert.equal(r.status, 10); assert.equal(r.stdout.trim(), 'https://quiet-sky-1234.trycloudflare.com');
  assert.equal(readFileSync(out, 'utf8'), 'https://quiet-sky-1234.trycloudflare.com\n');
  assert.equal(readFileSync(envFile, 'utf8'), 'SSS_MODE=quicktunnel\nSSS_ORIGIN=https://quiet-sky-1234.trycloudflare.com\n');
  // Unchanged address: exit 0, env file untouched.
  r = run('echo https://quiet-sky-1234.trycloudflare.com/', '--set-origin', envFile);
  assert.equal(r.status, 0); assert.equal(readFileSync(envFile, 'utf8').match(/SSS_ORIGIN=/g).length, 1);
  // A new address replaces the line (still exactly one).
  r = run('echo https://other-words-9.trycloudflare.com', '--quiet', '--set-origin', envFile);
  assert.equal(r.status, 10); assert.equal(r.stdout, '');
  assert.match(readFileSync(envFile, 'utf8'), /^SSS_ORIGIN=https:\/\/other-words-9\.trycloudflare\.com$/m);

  // Anything else is refused and leaves the earlier file alone.
  const before = readFileSync(envFile, 'utf8');
  for (const bad of ['evil.example.com', 'api.trycloudflare.com', 'a.trycloudflare.com.evil.com', 'x.trycloudflare.com;rm -rf', 'https://a b.trycloudflare.com', '-x.trycloudflare.com', '', 'http://x.trycloudflare.com:99']) {
    r = run(`printf '%s\\n' '${bad}'`, '--set-origin', envFile);
    assert.equal(r.status, 1, `should refuse: ${bad}`);
  }
  assert.equal(readFileSync(envFile, 'utf8'), before);
  assert.equal(readdirSync(work).filter(name => name.includes('.')).sort().join(), 'demo.env,url.txt');
});

// A loopback stand-in for Cloudflare in front of the app. Like Cloudflare it APPENDS the visitor's address to whatever
// X-Forwarded-For the client sent. The test names the visitor in a header the stand-in consumes (a real client cannot).
function standIn(appPort) {
  return http.createServer((req, res) => {
    const visitor = req.headers['x-test-visitor']; const headers = { ...req.headers };
    delete headers['x-test-visitor'];
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], visitor].filter(Boolean).join(', ');
    const up = http.request({ host: '127.0.0.1', port: appPort, path: req.url, method: req.method, headers }, back => { res.writeHead(back.statusCode, back.headers); back.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const post = (port, path, body, headers) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
    res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end(data);
});

test('header echo: behind a loopback proxy that appends the visitor, the sign-in limit buckets by the real (rightmost) address', async t => {
  const store = new Store(); const auth = new Auth(store);
  await auth.createUser('reviewer-ada', 'correct-horse-9-battery');
  const app = createServerFor({ store, auth, secure: false, origin: 'https://quiet-sky-1234.trycloudflare.com', trustedProxy: true });
  const appPort = await listen(app); const proxy = standIn(appPort); const port = await listen(proxy);
  t.after(() => { proxy.close(); app.close(); store.close(); });
  const login = (visitor, spoof, id, password) => post(port, '/api/login', { id, password },
    { 'x-test-visitor': visitor, ...(spoof ? { 'x-forwarded-for': spoof } : {}) });

  const A = '203.0.113.7'; const B = '198.51.100.20';
  // Visitor A burns its five tokens, rotating a different spoofed leftmost address every time. If the app believed the
  // spoof (leftmost) A would never be limited.
  for (let i = 0; i < 5; i += 1) assert.equal(await login(A, `192.0.2.${i + 1}`, `nobody-${i}`, 'wrong-password-1'), 400);
  // A's sixth attempt is refused even with the right password: the bucket is A's real address.
  assert.notEqual(await login(A, '192.0.2.99', 'reviewer-ada', 'correct-horse-9-battery'), 200);
  // Visitor B, from another address, is judged on its own. This fails if the app bucketed by the loopback peer (shared
  // by everyone behind the proxy). B even claims to be A in its own X-Forwarded-For: the appended entry still wins.
  assert.equal(await login(B, A, 'reviewer-ada', 'correct-horse-9-battery'), 200);
  // And a different spoof from A does not buy A a fresh bucket.
  assert.notEqual(await login(A, B, 'reviewer-ada', 'correct-horse-9-battery'), 200);
});

test('backup.sh: VACUUM INTO backup verifies, is a separate file, and prunes to the keep count', t => {
  const work = mkdtempSync(join(tmpdir(), 'sss-bk-')); const db = join(work, 'sss.db'); const out = join(work, 'backups');
  const store = new Store(db); store.close();
  const cli = join(dir, '../../cli.js');
  const env = { PATH: process.env.PATH, SSS_DB: db, SSS_BACKUP_DIR: out, SSS_BACKUP_MOUNT: out, SSS_BACKUP_TOOL: 'node', SSS_BACKUP_CLI: cli, SSS_BACKUP_KEEP: '2' };
  const run = () => spawnSync('sh', [join(dir, 'backup.sh')], { env, encoding: 'utf8' });
  for (let i = 0; i < 3; i += 1) {
    const r = run(); assert.equal(r.status, 0, r.stderr + r.stdout);
    if (i < 2) spawnSync('sleep', ['1.1']);   // the file name carries the second
  }
  const files = readdirSync(out).filter(name => name.endsWith('.sqlite'));
  assert.equal(files.length, 2); assert.ok(files.every(name => existsSync(join(out, `${name}.manifest.json`))));
  assert.notEqual(readFileSync(db).length, 0); assert.equal(spawnSync('sh', [join(dir, 'backup.sh')], { env: { ...env, SSS_BACKUP_KEEP: '0' }, encoding: 'utf8' }).status, 2);
});
