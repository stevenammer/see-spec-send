import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { OpenCodeAdapter } from '../worker/opencode.js';
import { validateBundle } from '../worker/bundle.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const request = { id: 'a'.repeat(64), item: 'synthetic', approval: 1, iteration: 0, spec_hash: 'b'.repeat(64), cap_micros: 0,
  spec: { must: ['Show only synthetic data'], how_we_know: ['A tester can see it'], out_of_scope: [] }, instructions: [{ instruction: 'Use blue', actor: 'person', source: 'raw-discussion-identity', mode: 'quoted' }] };
class Docker {
  constructor() { this.calls = []; this.live = new Map(); }
  run(args) { this.calls.push(args); const mount = args.find(value => value.includes('dst=/work')); const work = /src=([^,]+)/.exec(mount)[1]; const html = '<!doctype html><title>Synthetic</title><h1>Synthetic</h1>'; mkdirSync(join(work, 'bundle'), { recursive: true }); writeFileSync(join(work, 'bundle', 'index.html'), html); writeFileSync(join(work, 'manifest.json'), JSON.stringify({ version: 1, files: [{ path: 'index.html', bytes: Buffer.byteLength(html), sha256: sha(html) }] })); const name = args[args.indexOf('--name') + 1]; this.live.set(name, { State: { Running: false, ExitCode: 0 } }); return 'fake'; }
  inspect(name) { return this.live.get(name); }
  kill(name) { this.calls.push(['kill', name]); this.live.delete(name); }
  remove(name) { this.calls.push(['rm', name]); }
}
class Ledger { constructor() { this.revoked = []; } mint(_id, _ttl, save) { save('c'.repeat(64)); return 'd'.repeat(43); } revokeDigest(value) { this.revoked.push(value); } }
function adapter(t, extras = {}) { const root = mkdtempSync(join(tmpdir(), 'sss-opencode-')); const image = join(root, 'image'); writeFileSync(image, 'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a\n'); const store = new Store(); t.after(() => store.close()); const docker = new Docker(); return { root, docker, a: new OpenCodeAdapter(store, { docker, ledger: new Ledger(), root, gatewaySocket: join(root, 'gateway.sock'), imageFile: image, ...extras }) }; }

test('OpenCode is opt-in, locked down, gets only approved fields, and validates its bundle before ready', t => {
  const { a, docker } = adapter(t); a.start(request); const args = docker.calls[0].join(' ');
  for (const text of ['--network none', '--read-only', '--user 65532:65532', '--cap-drop ALL', '--pids-limit 32', '--memory 64m']) assert.match(args, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(args.includes('raw-discussion-identity'), false); assert.equal(args.includes('provider') && args.includes('KEY'), false);
  assert.deepEqual(a.status(request.id).state, 'ready');
});

test('own-key and paid modes are honestly refused', t => {
  const { root } = adapter(t); const image = join(root, 'image'); const store = new Store(); t.after(() => store.close());
  assert.throws(() => new OpenCodeAdapter(store, { root, gatewaySocket: join(root, 's'), imageFile: image, providerMode: 'own-key-paid' }), /spend not enforced/);
});

test('stop aborts a running OpenCode job and fences a later result', t => {
  const { a, docker } = adapter(t); a.start(request); docker.live.set(a.name(request.id), { State: { Running: true, ExitCode: null } }); assert.equal(a.stop(request.id).state, 'stopped'); assert.equal(a.status(request.id).state, 'stopped'); assert.ok(docker.calls.some(call => call[0] === 'kill'));
});

test('bundle rejects traversal, symlink, oversize, disallowed extension, and external script references', t => {
  const root = mkdtempSync(join(tmpdir(), 'sss-bundle-')); const file = (path, body) => { const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, body); return { path, bytes: Buffer.byteLength(body), sha256: sha(body) }; };
  const good = file('index.html', '<!doctype html><title>x</title><h1>x</h1>'); const manifest = { version: 1, files: [good] }; assert.equal(validateBundle(root, manifest).files.length, 1);
  assert.throws(() => validateBundle(root, { version: 1, files: [{ ...good, path: '../escape.html' }] }), /invalid file entry/);
  writeFileSync(join(root, 'bad.exe'), 'x'); assert.throws(() => validateBundle(root, manifest), /unexpected file|unsafe file/);
  // A separate tree avoids the unexpected file check and tests link handling itself.
  const links = mkdtempSync(join(tmpdir(), 'sss-bundle-link-')); symlinkSync('/etc/passwd', join(links, 'x.txt')); assert.throws(() => validateBundle(links, { version: 1, files: [{ path: 'x.txt', bytes: 1, sha256: sha('x') }] }), /unsafe file/);
  const script = mkdtempSync(join(tmpdir(), 'sss-bundle-script-')); const js = 'fetch("https://example.test")'; writeFileSync(join(script, 'app.js'), js); assert.throws(() => validateBundle(script, { version: 1, files: [{ path: 'app.js', bytes: Buffer.byteLength(js), sha256: sha(js) }] }), /external URL/);
  assert.throws(() => validateBundle(root, { version: 1, files: [{ ...good, bytes: 2 * 1024 * 1024 }] }, { maxBytes: 1024 }), /size limit/);
});
