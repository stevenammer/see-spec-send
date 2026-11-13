import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import * as http from '../app/http.js';
import * as cli from '../cli.js';

// Slice 19: serve it safely. Unit tests only: no listener is opened. Refusals happen before any socket exists,
// requests run through the in-process handler, and signals are simulated on an EventEmitter.
const root = fileURLToPath(new URL('..', import.meta.url));
const passphrase = 'correct horse battery staple';

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value; }
  end(value = '') { this.text += value; }
}
const send = async (handler, path, headers, body) => {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST'; req.url = path; req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, headers: res.headers, body: res.text ? JSON.parse(res.text) : null };
};
const get = async (handler, path) => {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = path; req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, headers: res.headers };
};
const selfSigned = directory => {
  const key = join(directory, 'key.pem'); const cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=sss-test'], { stdio: 'ignore' });
  return { key, cert };
};

test('serve refuses a non-loopback bind without TLS or a trusted proxy, and insecure cookies beyond loopback', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sss-s19-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { key, cert } = selfSigned(directory);
  const refused = (args, pattern) => assert.throws(() => cli.serveSettings(args, {}), error => pattern.test(error.message) && /refused/.test(error.message));
  refused(['--host', '0.0.0.0', '--port', '8787', '--origin', 'https://sss.example.test'], /TLS|trusted proxy/);
  refused(['--host', '0.0.0.0', '--trusted-proxy', '--insecure-cookies', '--origin', 'http://x'], /insecure/);
  refused(['--host', '0.0.0.0', '--tls-cert', cert, '--tls-key', key, '--insecure-cookies'], /insecure/);
  refused(['--tls-cert', cert], /together/);
  refused(['--tls-key', key], /together/);
  refused(['--trusted-proxy', '--insecure-cookies'], /insecure/);
  refused(['--tls-cert', cert, '--tls-key', key, '--trusted-proxy', '--insecure-cookies'], /insecure/);
  assert.doesNotThrow(() => cli.serveSettings(['--host', '0.0.0.0', '--trusted-proxy', '--origin', 'https://sss.example.test'], {}));
  assert.doesNotThrow(() => cli.serveSettings(['--port', '8787', '--insecure-cookies', '--origin', 'http://127.0.0.1:8787'], {}));
  const direct = cli.serveSettings(['--host', '0.0.0.0', '--tls-cert', cert, '--tls-key', key, '--origin', 'https://sss.example.test'], {});
  assert.equal(direct.secure, true);
  assert.equal(direct.trustedProxy, false);
  assert.ok(direct.tls.cert.equals(readFileSync(cert)));
  assert.ok(direct.tls.key.equals(readFileSync(key)));
  const proxied = cli.serveSettings(['--host', '0.0.0.0', '--trusted-proxy', '--origin', 'https://sss.example.test'], {});
  assert.equal(proxied.trustedProxy, true);
  assert.equal(proxied.tls, null);
  assert.equal(proxied.secure, true);
});

test('the forwarded client address is honored only from a loopback proxy, and only its rightmost hop', () => {
  const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });
  assert.equal(http.clientAddress(req('127.0.0.1', '203.0.113.9'), true), '203.0.113.9');
  assert.equal(http.clientAddress(req('127.0.0.1', '10.0.0.1, 203.0.113.9'), true), '203.0.113.9');
  assert.equal(http.clientAddress(req('::1', '203.0.113.9'), true), '203.0.113.9');
  assert.equal(http.clientAddress(req('127.0.0.1', '2001:db8::7'), true), '2001:db8::7');
  assert.equal(http.clientAddress(req('198.51.100.20', '192.0.2.1'), true), '198.51.100.20');
  assert.equal(http.clientAddress(req('127.0.0.1', '203.0.113.9'), false), '127.0.0.1');
  assert.equal(http.clientAddress(req('127.0.0.1', 'not an address'), true), '127.0.0.1');
  assert.equal(http.clientAddress(req('127.0.0.1', undefined), true), '127.0.0.1');
});

test('through one loopback proxy, each client address has its own sign-in lockout', async () => {
  const now = Date.UTC(2026, 10, 13);
  const store = new Store(); const auth = new Auth(store, { clock: () => now });
  await auth.createUser('leader', passphrase, true);
  const handler = http.createHandler({ store, auth, secure: true, origin: 'https://sss.example.test', trustedProxy: true, clock: () => now });
  const attempt = (forwarded, password) => send(handler, '/api/login', { 'x-forwarded-for': forwarded }, { id: 'leader', password });
  for (let i = 0; i < 4; i += 1) assert.equal((await attempt('203.0.113.9', 'wrong password here')).status, 400);
  assert.equal((await attempt('203.0.113.9', passphrase)).status, 400);
  assert.equal((await attempt('198.51.100.7', passphrase)).status, 200);
});

test('without a trusted proxy, every request through the proxy shares one address and one lockout', async () => {
  const now = Date.UTC(2026, 10, 13);
  const store = new Store(); const auth = new Auth(store, { clock: () => now });
  await auth.createUser('leader', passphrase, true);
  const handler = http.createHandler({ store, auth, secure: true, origin: 'https://sss.example.test', trustedProxy: false, clock: () => now });
  const attempt = (forwarded, password) => send(handler, '/api/login', { 'x-forwarded-for': forwarded }, { id: 'leader', password });
  for (let i = 0; i < 4; i += 1) assert.equal((await attempt('203.0.113.9', 'wrong password here')).status, 400);
  assert.equal((await attempt('198.51.100.7', passphrase)).status, 400);
});

test('HSTS is sent exactly when cookies are secure', async () => {
  const store = new Store(); const auth = new Auth(store);
  const secure = http.createHandler({ store, auth, secure: true, origin: 'https://sss.example.test' });
  const plain = http.createHandler({ store, auth, secure: false, origin: 'http://127.0.0.1:8787' });
  assert.match((await get(secure, '/signin')).headers['strict-transport-security'] || '', /^max-age=\d+/);
  assert.equal((await get(plain, '/signin')).headers['strict-transport-security'], undefined);
});

test('SIGTERM closes the listener before the database, exits 0, and a second signal changes nothing', () => {
  const events = []; const exits = []; const proc = new EventEmitter();
  const server = {
    close(done) { events.push('listener closed'); done(); },
    closeIdleConnections() { events.push('idle connections closed'); },
  };
  const store = { close() { events.push('database closed'); } };
  cli.stopOnSignal(server, store, { proc, exit: code => exits.push(code), write: () => {} });
  proc.emit('SIGTERM');
  proc.emit('SIGTERM');
  assert.deepEqual(events, ['idle connections closed', 'listener closed', 'database closed']);
  assert.deepEqual(exits, [0]);
});

test('an HTTPS server is built from the certificate pair without opening a listener', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sss-s19-tls-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { key, cert } = selfSigned(directory);
  const store = new Store(); const auth = new Auth(store);
  const server = http.createServerFor({ store, auth, secure: true, origin: 'https://sss.example.test', tls: { cert: readFileSync(cert), key: readFileSync(key) } });
  assert.ok(server instanceof https.Server);
  const plain = http.createServerFor({ store, auth, secure: true, origin: 'https://sss.example.test', tls: null });
  assert.equal(plain instanceof https.Server, false);
});

test('compose publishes only on loopback, puts TLS ahead of the server, and hardens every service', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
  const digest = readFileSync(join(root, 'worker/builder-image.digest'), 'utf8').trim();
  assert.doesNotMatch(compose, /insecure-cookies/);
  assert.doesNotMatch(compose, /"8787:8787"|"8443:8443"|"0\.0\.0\.0:/);
  assert.match(compose, /"127\.0\.0\.1:8443:8443"/);
  assert.match(compose, /--trusted-proxy/);
  assert.match(compose, /network_mode: "service:server"/);
  const services = (compose.match(/^ {2}[a-z]+:$/gm) || []).length;
  assert.equal(services, 4);
  assert.equal((compose.match(/^ {4}read_only: true$/gm) || []).length, services);
  assert.equal((compose.match(/^ {4}restart: unless-stopped$/gm) || []).length, services);
  assert.equal((compose.match(/^ {4}user: "1000:1000"$|^ {4}user: "101"$/gm) || []).length, services);
  assert.match(compose, /^ {4}healthcheck:$/m);
  for (const [, image] of compose.matchAll(/^ {4}image: (.+)$/gm)) {
    const pinned = image === `node:22-alpine@sha256:${digest.split('@sha256:')[1]}` || image.startsWith('${SSS_TLS_IMAGE:?');
    assert.ok(pinned, `unpinned image: ${image}`);
  }
});

test('the TLS front end appends the client address and forwards only to the loopback server', () => {
  const front = readFileSync(join(root, 'deploy/tls-front.conf'), 'utf8');
  assert.match(front, /listen 8443 ssl;/);
  assert.match(front, /proxy_pass http:\/\/127\.0\.0\.1:8787;/);
  assert.match(front, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  assert.doesNotMatch(front, /\$http_x_forwarded_for/);
});

test('systemd units exist for the server and the worker, not only the watchdog', () => {
  const server = readFileSync(join(root, 'docs/systemd/see-spec-send-server.service'), 'utf8');
  const worker = readFileSync(join(root, 'docs/systemd/see-spec-send-worker.service'), 'utf8');
  assert.match(server, /ExecStart=.*cli\.js serve/);
  assert.match(server, /--trusted-proxy/);
  assert.doesNotMatch(server, /--insecure-cookies/);
  assert.match(worker, /ExecStart=.*cli\.js worker/);
  for (const unit of [server, worker]) {
    assert.match(unit, /^User=see-spec-send$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^Restart=on-failure$/m);
  }
});
