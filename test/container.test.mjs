import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { ContainerAdapter } from '../worker/container.js';
import { adapterConformance } from './worker.test.mjs';

const id = value => value.repeat(64);
class FakeDocker {
  constructor() { this.calls = []; this.entries = new Map(); }
  run(args) {
    this.calls.push(args);
    const name = args[args.indexOf('--name') + 1];
    const out = args.find(value => value.includes('dst=/out'));
    const source = /src=([^,]+)/.exec(out)[1];
    writeFileSync(join(source, 'try.html'), '<!doctype html><title>Small try</title><h1>Small try</h1>');
    this.entries.set(name, { State: { Running: false, ExitCode: 0 } }); return 'container-id';
  }
  inspect(name) { return this.entries.get(name) || null; }
  kill(name) { this.calls.push(['kill', name]); this.entries.delete(name); }
  remove(name) { this.calls.push(['rm', name]); }
}
class FakeLedger {
  constructor() { this.minted = []; this.revoked = []; }
  mint(run, _ttl, persist = () => {}) { const token = `${run}`.slice(0, 43).padEnd(43, 'a'); this.minted.push(token); persist('a'.repeat(64)); return token; }
  revokeDigest(value) { this.revoked.push(value); }
}
function adapter(store, extras = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sss-container-'));
  const image = join(root, 'image');
  writeFileSync(image, 'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a\n');
  return new ContainerAdapter(store, { docker: new FakeDocker(), ledger: new FakeLedger(), root,
    gatewaySocket: join(root, 'gateway.sock'), imageFile: image, ...extras });
}

adapterConformance('container', adapter, s => s.db.prepare('SELECT count(*) AS n FROM container_jobs').get().n);

test('container adapter persists before Docker and supplies every locked-down Docker control', () => {
  const store = new Store(); const docker = new FakeDocker(); const ledger = new FakeLedger();
  const root = mkdtempSync(join(tmpdir(), 'sss-container-')); const image = join(root, 'image');
  writeFileSync(image, 'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a\n');
  const a = new ContainerAdapter(store, { docker, ledger, root, gatewaySocket: join(root, 'gateway.sock'), imageFile: image, wallMs: 1234 });
  const request = { id: id('a'), item: 'item', approval: 1, spec_hash: id('b'), cap_micros: 10,
    spec: { must: ['m'], how_we_know: ['k'], out_of_scope: ['o'] } };
  a.start(request);
  assert.equal(store.db.prepare('SELECT state FROM container_jobs').get().state, 'running');
  const args = docker.calls[0];
  const has = (flag, value) => value === undefined ? args.includes(flag) : args.some((entry, index) => entry === flag && args[index + 1] === value);
  for (const [flag, value] of [['--network', 'none'], ['--read-only'], ['--user', '65532:65532'], ['--cap-drop', 'ALL'],
    ['--pids-limit', '32'], ['--cpus', '0.50'], ['--memory', '64m'], ['--memory-swap', '64m'],
    ['--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m']]) assert.equal(has(flag, value), true, `${flag} is missing or weakened`);
  assert.equal(args.includes('--security-opt') && args[args.indexOf('--security-opt') + 1] === 'no-new-privileges=true', true);
  assert.ok(args.some(value => /^node:22-alpine@sha256:/.test(value)));
  assert.equal(args[args.indexOf('SSS_GATEWAY_MODEL=fixture:text-v1')], 'SSS_GATEWAY_MODEL=fixture:text-v1');
  process.env.SSS_TEST_PROVIDER_SECRET = 'provider-secret-must-not-enter-container';
  assert.equal(args.join(' ').includes(process.env.SSS_TEST_PROVIDER_SECRET), false, 'provider secret entered container arguments');
  assert.equal(args.some(value => /PROVIDER|API.?KEY|SECRET/.test(value)), false, 'provider credential environment was mounted');
  assert.equal(args.filter(value => value.includes('type=bind')).some(value => /providers|secret|key/i.test(value)), false, 'provider credential mount was added');
  delete process.env.SSS_TEST_PROVIDER_SECRET;
  assert.match(readFileSync(join(root, request.id, 'spec.json'), 'utf8'), /"must"/);
  assert.equal(a.status(request.id).state, 'ready');
  a.stop(request.id); assert.ok(ledger.revoked.length >= 1);
  store.close();
});

test('container wall deadline stops a still-running container and fences its restart', () => {
  const store = new Store(); let now = 10; const docker = new FakeDocker(); docker.inspect = () => ({ State: { Running: true, ExitCode: null } });
  const root = mkdtempSync(join(tmpdir(), 'sss-container-')); const image = join(root, 'image');
  writeFileSync(image, 'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a\n');
  const a = new ContainerAdapter(store, { docker, ledger: new FakeLedger(), root, gatewaySocket: join(root, 'gateway.sock'), imageFile: image, wallMs: 5, now: () => now });
  const request = { id: id('c'), item: 'i', approval: 1, spec_hash: id('d'), cap_micros: 0, spec: { must: [], how_we_know: [], out_of_scope: [] } };
  a.start(request); now = 20; assert.equal(a.status(request.id).state, 'stopped'); a.start(request);
  assert.equal(a.status(request.id).state, 'stopped'); assert.ok(docker.calls.some(call => call[0] === 'kill'));
  store.close();
});

test('a repeated start resumes a live run, and a crash after minting adopts or relaunches exactly once', () => {
  const request = { id: id('c'), item: 'item', approval: 1, spec_hash: id('d'), cap_micros: 10,
    spec: { must: ['m'], how_we_know: ['k'], out_of_scope: ['o'] } };
  const make = () => {
    const store = new Store(); const docker = new FakeDocker(); const ledger = new FakeLedger();
    const root = mkdtempSync(join(tmpdir(), 'sss-container-')); const image = join(root, 'image');
    writeFileSync(image, 'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a\n');
    docker.run = args => { docker.calls.push(args); docker.entries.set(args[args.indexOf('--name') + 1], { State: { Running: true } }); return 'id'; };
    return { store, docker, ledger, a: new ContainerAdapter(store, { docker, ledger, root, gatewaySocket: join(root, 'gateway.sock'), imageFile: image }) };
  };
  // Repeating start while the container is live must not launch a second one.
  let t = make(); t.a.start(request); t.a.start(request);
  assert.equal(t.docker.calls.filter(call => call[0] === 'run').length, 1);
  assert.equal(t.a.status(request.id).state, 'running'); t.store.close();
  // Crash after minting but before running: no container exists, so launch once and revoke the orphaned token.
  t = make(); t.a.persist(request); t.store.db.prepare("UPDATE container_jobs SET state='starting', token_digest=? WHERE id=?").run('e'.repeat(64), request.id);
  t.a.start(request);
  assert.equal(t.docker.calls.filter(call => call[0] === 'run').length, 1);
  assert.ok(t.ledger.revoked.includes('e'.repeat(64)));
  t.store.close();
  // Crash after the container launched: adopt it without launching another.
  t = make(); t.a.persist(request); t.store.db.prepare("UPDATE container_jobs SET state='starting' WHERE id=?").run(request.id);
  t.docker.entries.set(t.a.row(request.id).container_name, { State: { Running: true } });
  t.a.start(request);
  assert.equal(t.docker.calls.filter(call => call[0] === 'run').length, 0);
  assert.equal(t.a.row(request.id).state, 'running'); t.store.close();
});
