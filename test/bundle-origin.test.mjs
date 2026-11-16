import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../core/store.js';
import { createBundleServer, bundleUrl } from '../app/bundle-origin.js';
import { serveSettings } from '../cli.js';
import { fixture } from './helpers/gateway-fixture.mjs';
import { Worker } from '../worker/runner.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function artifact(files) {
  const entries = Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: hash(text) }));
  return JSON.stringify({ sss_bundle: 1, manifest: { version: 1, files: entries }, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')])) });
}
class Response { constructor() { this.headers = {}; this.status = 200; this.body = Buffer.alloc(0); } writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); } end(data = '') { this.body = Buffer.concat([this.body, Buffer.isBuffer(data) ? data : Buffer.from(data)]); } }
async function call(server, method, host, path) { const req = Readable.from([]); req.method = method; req.url = path; req.headers = { host }; const res = new Response(); server.emit('request', req, res); return res; }

function readyBundle() {
  const f = fixture(); const bytes = artifact({ 'index.html': '<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script><textarea id="note"></textarea>', 'style.css': 'textarea{color:rgb(1,2,3)}', 'app.js': 'localStorage.setItem("x","1")', 'readme.md': 'synthetic' });
  const artifactHash = f.store.putArtifact('item', bytes);
  f.store.append('item', { type: 'tried', actor: f.run.run_actor, approval: f.run.approval, spec_hash: f.run.spec_hash, iteration: 0, artifact_hash: artifactHash, model_output: true, at: new Date().toISOString() }, { idem: 'bundle' });
  return { ...f, artifactHash, bytes };
}

test('bundle origin authenticates host labels and serves only manifest files with strict headers', async () => {
  const f = readyBundle(); const secret = randomBytes(32); const server = createBundleServer({ store: f.store, secret, hostSuffix: 'localhost', appOrigin: 'http://127.0.0.1:8080' });
  try {
    const url = new URL(bundleUrl(secret, f.artifactHash, 'localhost', 9090));
    const ok = await call(server, 'GET', url.host, '/');
    assert.equal(ok.status, 200); assert.match(ok.body.toString(), /textarea/); assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff'); assert.equal(ok.headers['cache-control'], 'no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.equal(ok.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:8080; sandbox allow-scripts allow-same-origin");
    assert.equal((await call(server, 'HEAD', url.host, '/style.css')).headers['content-type'], 'text/css; charset=utf-8');
    for (const [method, host, path] of [['POST', url.host, '/'], ['GET', 'wrong.localhost', '/'], ['GET', url.host, '/../index.html'], ['GET', url.host, '/%2e%2e/index.html'], ['GET', url.host, '/%5cindex.html'], ['GET', url.host, '/.hidden'], ['GET', url.host, '/missing.js']]) assert.equal((await call(server, method, host, path)).status, 404, `${method} ${host}${path}`);
  } finally { f.store.close(); }
});

test('artifact hash prefix lookup is read-only and refuses ambiguous or short prefixes', () => {
  const { store, artifactHash } = readyBundle(); try {
    assert.equal(store.artifactByHashPrefix(artifactHash.slice(0, 31)), null);
    assert.equal(store.artifactByHashPrefix(artifactHash.slice(0, 32)).hash, artifactHash);
  } finally { store.close(); }
});

test('serve rejects a bundle listener that could share the app origin', () => {
  assert.throws(() => serveSettings(['--origin', 'http://anything.localhost:9001', '--bundle-port', '9001']), /bundle origin could equal/);
  assert.equal(serveSettings(['--bundle-port', '9001']).bundleHostSuffix, 'localhost');
});

test('runner delivers a bundle artifact and retains model-output attribution', () => {
  const f = fixture(); const bytes = artifact({ 'index.html': '<!doctype html><p>synthetic</p>' });
  const adapter = { modelOutput: true, start() {}, stop() { return { state: 'stopped' }; }, status() { return { state: 'ready', html: '<p>fallback</p>', bundleArtifact: bytes }; } };
  try {
    new Worker(f.store, adapter).reconcile();
    const event = f.store.events('item').find(row => row.type === 'tried');
    assert.equal(event.model_output, true); assert.equal(f.store.artifact('item', event.artifact_hash), bytes);
  } finally { f.store.close(); }
});
