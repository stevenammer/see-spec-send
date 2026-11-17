import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
function adapter(t, extras = {}) { const root = mkdtempSync(join(tmpdir(), 'sss-opencode-')); const image = join(root, 'image'); writeFileSync(image, 'sha256:f466e0430d7eba33cde07b7fa8823ecac2bf8db2957703b893288c7784a159e4'); const store = new Store(); t.after(() => store.close()); const docker = new Docker(); return { root, docker, a: new OpenCodeAdapter(store, { docker, ledger: new Ledger(), root, gatewaySocket: join(root, 'gateway.sock'), imageFile: image, ...extras }) }; }

test('OpenCode is opt-in, locked down, gets only approved fields, and validates its bundle before ready', t => {
  const { a, docker } = adapter(t); a.start(request); const args = docker.calls[0].join(' ');
  for (const text of ['--network none', '--read-only', '--user 65532:65532', '--cap-drop ALL', '--pids-limit 256', '--memory 1g']) assert.match(args, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(args.includes('raw-discussion-identity'), false); assert.equal(args.includes('provider') && args.includes('KEY'), false);
  const ready = a.status(request.id);
  assert.deepEqual(ready.state, 'ready');
  assert.equal(typeof ready.html, 'string', 'a ready bundle carries its reviewable single-document try');
  assert.doesNotMatch(ready.html, /<script/i);
  assert.equal(a.status(request.id).html, ready.html, 'the same document is produced after the job is already ready');
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

// A fake Docker whose successive runs write successive outputs: a string is an index.html, null is an empty bundle,
// and undefined is a manifest that is not valid JSON (a failure the validator cannot explain).
class RepairDocker extends Docker {
  constructor(outputs, { failSecond = false } = {}) { super(); this.outputs = outputs; this.starts = 0; this.failSecond = failSecond; }
  run(args) {
    this.calls.push(args);
    const index = this.starts; this.starts += 1;
    if (this.failSecond && index === 1) throw new Error('docker refused');
    const work = /src=([^,]+)/.exec(args.find(value => value.includes('dst=/work')))[1];
    const html = this.outputs[Math.min(index, this.outputs.length - 1)];
    if (html === 'hold') { this.live.set(args[args.indexOf('--name') + 1], { State: { Running: true, ExitCode: null } }); return 'fake'; }
    mkdirSync(join(work, 'bundle'), { recursive: true });
    if (typeof html === 'string') { writeFileSync(join(work, 'bundle', 'index.html'), html); writeFileSync(join(work, 'manifest.json'), JSON.stringify({ version: 1, files: [{ path: 'index.html', bytes: Buffer.byteLength(html), sha256: sha(html) }] })); }
    else writeFileSync(join(work, 'manifest.json'), html === null ? JSON.stringify({ version: 1, files: [] }) : '{');
    this.live.set(args[args.indexOf('--name') + 1], { State: { Running: false, ExitCode: 0 } });
    return 'fake';
  }
}
class CountingLedger {
  constructor() { this.minted = []; this.revoked = []; }
  mint(_id, _ttl, save) { const n = this.minted.length + 1; const value = String(n).repeat(64).slice(0, 64); this.minted.push(value); save(value); return String.fromCharCode(96 + n).repeat(43); }
  revokeDigest(value) { this.revoked.push(value); }
}
const GOOD = '<!doctype html><title>Synthetic</title><h1>Synthetic</h1>';
const BAD = '<!doctype html><title>Synthetic</title><a>link</a>';
const timeoutSeconds = args => args[args.indexOf('timeout') + 3];

test('a refused build gets one repair pass with the exact reason, a new capability, and the same run', t => {
  const docker = new RepairDocker([BAD, GOOD]), ledger = new CountingLedger();
  const { a } = adapter(t, { docker, ledger, wallMs: 300_000 });
  a.start(request);
  assert.equal(a.status(request.id).state, 'running', 'the refusal starts a repair instead of failing');
  assert.equal(docker.starts, 2);
  const paths = a.paths(request.id);
  assert.match(readFileSync(paths.repair, 'utf8'), /^index\.html: the element <a> is not allowed/);
  assert.ok(docker.calls.some(call => call[0] === 'rm'), 'the finished container was removed so its name can be reused');
  assert.deepEqual(ledger.revoked, ['1'.repeat(64)], 'the first capability is revoked');
  assert.equal(ledger.minted.length, 2, 'the repair pass has its own capability');
  assert.equal(JSON.parse(readFileSync(paths.config, 'utf8')).provider.sss.options.apiKey, 'b'.repeat(43), 'the agent is configured with the new capability');
  assert.equal(a.status(request.id).state, 'ready', 'the repaired build is accepted');
});

test('there is only ever one repair pass, and a build refused twice fails with every capability revoked', t => {
  const docker = new RepairDocker([BAD, BAD]), ledger = new CountingLedger();
  const { a } = adapter(t, { docker, ledger, wallMs: 300_000 });
  a.start(request);
  assert.equal(a.status(request.id).state, 'running');
  assert.equal(a.status(request.id).state, 'failed');
  assert.equal(a.status(request.id).state, 'failed');
  assert.equal(docker.starts, 2, 'no third attempt');
  assert.deepEqual(ledger.revoked.sort(), ['1'.repeat(64), '2'.repeat(64)]);
});

test('an empty bundle is repairable, and a failure the validator cannot explain is not', t => {
  const empty = new RepairDocker([null, GOOD]); const one = adapter(t, { docker: empty, ledger: new CountingLedger(), wallMs: 300_000 });
  one.a.start(request);
  assert.equal(one.a.status(request.id).state, 'running');
  assert.match(readFileSync(one.a.paths(request.id).repair, 'utf8'), /no files were found in \.\/bundle\//);
  assert.equal(one.a.status(request.id).state, 'ready');
  const opaque = new RepairDocker([undefined, GOOD]); const two = adapter(t, { docker: opaque, ledger: new CountingLedger(), wallMs: 300_000 });
  two.a.start(request);
  assert.equal(two.a.status(request.id).state, 'failed');
  assert.equal(opaque.starts, 1, 'no repair without a reason to give');
});

test('a repair gets only the wall time that is left, and none when too little is left', t => {
  let clock = 1_000_000;
  const docker = new RepairDocker([BAD, GOOD]);
  const { a } = adapter(t, { docker, ledger: new CountingLedger(), wallMs: 300_000, now: () => clock });
  a.start(request);
  assert.equal(timeoutSeconds(docker.calls[0]), '300');
  clock += 100_000;
  assert.equal(a.status(request.id).state, 'running');
  assert.equal(timeoutSeconds(docker.calls.find(call => call[0] === 'run' && call !== docker.calls[0])), '195', '300 s minus 100 s used minus a 5 s margin');
  let late = 1_000_000;
  const tight = new RepairDocker([BAD, GOOD]); const other = adapter(t, { docker: tight, ledger: new CountingLedger(), wallMs: 60_000, now: () => late });
  other.a.start(request); late += 30_000;
  assert.equal(other.a.status(request.id).state, 'failed', 'under 45 seconds left, so no repair');
  assert.equal(tight.starts, 1);
});

test('a repair that cannot start fails the build and revokes the capability it minted', t => {
  const docker = new RepairDocker([BAD, GOOD], { failSecond: true }), ledger = new CountingLedger();
  const { a } = adapter(t, { docker, ledger, wallMs: 300_000 });
  a.start(request);
  assert.equal(a.status(request.id).state, 'failed');
  assert.equal(ledger.minted.length, 2);
  assert.ok(ledger.revoked.includes('2'.repeat(64)), 'the capability the failed repair minted is revoked');
});

test('the first attempt\'s manifest is cleared while the repair runs, so it cannot be mistaken for the repaired build', t => {
  const docker = new RepairDocker([BAD, 'hold']);
  const { a } = adapter(t, { docker, ledger: new CountingLedger(), wallMs: 300_000 });
  a.start(request);
  assert.equal(a.status(request.id).state, 'running');
  assert.equal(existsSync(a.paths(request.id).manifest), false);
});
