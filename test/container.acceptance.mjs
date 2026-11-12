// Run this outside the restricted sandbox: npm run test:container.
// It uses only the local Docker daemon and the local mock gateway. It never uses a network service.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { ContainerAdapter, DockerCli } from '../worker/container.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { Gateway, createGatewayServer, providerGateway } from '../gateway/http.js';
import { createServer } from 'node:http';
import { saveProviders, meteredProviderFor } from '../provider/config.js';

const sh = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options }).trim();
const image = readFileSync(new URL('../worker/builder-image.digest', import.meta.url), 'utf8').trim();
after(() => { try { const ids = sh(['ps', '-aq', '--filter', 'name=sss-']); if (ids) sh(['rm', '-f', ...ids.split('\n')]); } catch {} });
const runId = 'a'.repeat(64);
const put = (s, type, actor, body = {}) => s.append('item', { type, actor, at: '2026-11-12', ...body }, { idem: `${type}:${s.events('item').length}` });
function approved(store) {
  store.registerPerson('writer'); store.registerPerson('leader', { leader: true });
  put(store, 'checked', 'writer', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' });
  put(store, 'specced', 'writer', { must: ['m'], how_we_know: ['k'], out_of_scope: ['o'] });
  put(store, 'approved', 'leader', { spec_hash: store.read('item').context.specHash, cap_usd: 1, quorum: 1 });
}
function dockerAvailable() {
  try { sh(['image', 'inspect', image]); return true; } catch { return false; }
}
// A missing Docker image must fail loudly, never skip: a skipped acceptance run proves nothing.
const available = dockerAvailable();
if (!available) throw new Error(`Pinned builder image is not available locally. Run: docker pull ${image}`);
test('Docker image pinned for this adapter is locally available', () => assert.match(image, /@sha256:[a-f0-9]{64}$/));

test('locked real container refuses egress, host reads, writes outside output, pids and memory', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-container-accept-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = join(dir, 'spec.json'); const out = join(dir, 'out'); const socket = join(dir, 'gateway.sock'); const secret = join(dir, 'host-secret');
  writeFileSync(spec, JSON.stringify({ must: [], how_we_know: [], out_of_scope: [] })); writeFileSync(secret, 'host-only'); await listenSocket(t, socket);
  const store = new Store(join(dir, 'db')); const ledger = new Ledger(store); ledger.configure(fixturePolicy());
  const adapter = new ContainerAdapter(store, { root: dir, gatewaySocket: socket });
  // Build a command with the adapter's exact hardening args. It exits nonzero if any escape works.
  const row = { container_name: 'sss-accept-controls' };
  const paths = { spec, out, html: join(out, 'try.html') }; mkdir(out);
  chmodSync(out, 0o733);
  const script = "const fs=require('fs'),net=require('net');let bad=0;try{fs.readFileSync('/host-secret');bad++}catch{};try{fs.writeFileSync('/work/nope','x');bad++}catch{};const s=net.connect(443,'1.1.1.1');s.on('error',()=>{});s.on('connect',()=>bad++);setTimeout(()=>{fs.writeFileSync('/out/result.json',JSON.stringify({bad}));process.exit(bad)},300)";
  const args = adapter.dockerArgs(row, paths, 'a'.repeat(43));
  args.splice(args.indexOf(image) + 1, 2, 'node', '-e', script);
  const cid = sh(args); t.after(() => { try { sh(['rm', '-f', cid]); } catch {} store.close(); });
  assert.equal(Number(sh(['wait', cid])), 0, 'an escape probe succeeded');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')), { bad: 0 });
  const inspected = JSON.parse(sh(['inspect', cid]))[0];
  assert.equal(inspected.HostConfig.NetworkMode, 'none');
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.PidsLimit, 32);
  assert.equal(inspected.HostConfig.Memory, 64 * 1024 * 1024);
  assert.equal(inspected.HostConfig.MemorySwap, 64 * 1024 * 1024);
  assert.equal(inspected.Config.User, '65532:65532');
  assert.equal(inspected.HostConfig.CapDrop.includes('ALL'), true);
  assert.equal(inspected.HostConfig.SecurityOpt.includes('no-new-privileges=true'), true);
});

test('real PID and memory limits stop resource exhaustion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-container-resource-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'db')); t.after(() => store.close()); const socket = join(dir, 'gateway.sock'); await listenSocket(t, socket);
  const adapter = new ContainerAdapter(store, { root: dir, gatewaySocket: socket }); const spec = join(dir, 'spec.json'); const out = join(dir, 'out'); mkdir(out); chmodSync(out, 0o733); writeFileSync(spec, '{}');
  const run = (name, script, command = ['node', '-e', script]) => {
    const args = adapter.dockerArgs({ container_name: name }, { spec, out, html: join(out, 'try.html') }, 'a'.repeat(43));
    args.splice(args.indexOf(image) + 1, 2, ...command); const cid = sh(args); t.after(() => { try { sh(['rm', '-f', cid]); } catch {} }); return cid;
  };
  // The shell starts sleepers until fork fails. A working PID limit makes the shell report that it cannot fork.
  const forks = run('sss-accept-pids', null, ['sh', '-c', "i=0; while [ $i -lt 120 ]; do sleep 100 >/dev/null 2>&1 & i=$((i+1)); done 2>&1 | tail -1; exit 0"]);
  assert.equal(Number(sh(['wait', forks])), 0, 'PID probe did not finish');
  assert.match(execFileSync('docker', ['logs', forks], { encoding: 'utf8' }), /can't fork/, 'PID limit did not refuse new processes');
  const memory = run('sss-accept-memory', 'Buffer.alloc(256*1024*1024,1);setInterval(()=>{},1000)');
  assert.notEqual(Number(sh(['wait', memory])), 0, 'memory limit did not stop a 256 MiB allocation');
});


// The adapter bind-mounts the gateway socket, so Docker needs a real listening socket to exist.
async function listenSocket(t, path) {
  const server = net.createServer(connection => connection.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, 0o666); t.after(() => server.close());
}

test('a real container builds a page through the gateway and a configured provider, and never holds its key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-container-provider-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const SECRET = 'provider-credential-must-not-leak-9f3a';
  t.after(() => { try { const ids = sh(['ps', '-aq', '--filter', 'name=sss-builder']); if (ids) sh(['rm', '-f', ...ids.split('\n')]); } catch {} });
  let seenAuth = null; let calls = 0;
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; calls++; seenAuth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Here you go:\n```html\n<!doctype html><title>Model try</title><h1>Model try</h1>\n```' } }], usage: { prompt_tokens: 30, completion_tokens: 12 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => upstream.close());
  const env = { ...process.env, SSS_PROVIDERS_FILE: join(dir, 'providers.json'), SSS_TEST_PROVIDER_KEY: SECRET };
  saveProviders({ providers: [{ name: 'mock', kind: 'openai', model: 'mock-model', enabled: true, url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
    hosts: ['127.0.0.1'], allowPrivate: true, apiKeyEnv: 'SSS_TEST_PROVIDER_KEY', price: { inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 200_000 } }], defaults: { default: 'mock' } }, env);
  const store = new Store(join(dir, 'db')); t.after(() => store.close()); approved(store);
  const selected = meteredProviderFor('mock', env);
  const ledger = new Ledger(store, { rate: selected.rate }); ledger.configure(fixturePolicy());
  const server = createGatewayServer(providerGateway(ledger, selected.provider, { system: 'Return one static HTML page.' }));
  const socket = join(dir, 'gateway.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); chmodSync(socket, 0o666); t.after(() => server.close());
  const adapter = new ContainerAdapter(store, { root: join(dir, 'jobs'), gatewaySocket: socket, wallMs: 20_000, providerEnv: env, providerName: 'mock' });
  const worker = new Worker(store, adapter); worker.reconcile();
  let sawContainerEnv = '';
  for (let i = 0; i < 60 && store.read('item').state !== 'TRYING'; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try { const names = sh(['ps', '-a', '--filter', 'name=sss-builder', '--format', '{{.Names}}']).split('\n').filter(Boolean);
      for (const name of names) sawContainerEnv += sh(['inspect', name, '--format', '{{json .Config.Env}}{{json .Args}}{{json .Mounts}}']); } catch {}
    worker.reconcile();
  }
  let logs = ''; if (store.read('item').state !== 'TRYING') { try { for (const name of sh(['ps', '-a', '--filter', 'name=sss-builder', '--format', '{{.Names}}']).split('\n').filter(Boolean)) logs += execFileSync('docker', ['logs', name], { encoding: 'utf8' }); } catch {} }
  assert.equal(store.read('item').state, 'TRYING', `a model-built page was not delivered (state ${store.read('item').state}, provider calls ${calls}, builder logs: ${logs})`);
  assert.match(store.artifact('item', store.read('item').context.artifact), /Model try/);
  assert.ok(calls >= 1, 'the configured provider was never called');
  assert.equal(seenAuth, `Bearer ${SECRET}`, 'the gateway did not authenticate to the provider');
  assert.ok(sawContainerEnv.length > 0, 'could not inspect the builder container');
  assert.equal(sawContainerEnv.includes(SECRET), false, 'the provider key reached the container');
});

function mkdir(path) { try { execFileSync('mkdir', ['-p', path]); } catch {} }

test('wall clock and stop kill a real container, and the worker delivers a gateway-built try', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-container-e2e-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'db'); const socket = join(dir, 'gateway.sock'); const store = new Store(db); t.after(() => store.close()); approved(store);
  const ledger = new Ledger(store); ledger.configure(fixturePolicy());
  const server = createGatewayServer(new Gateway(ledger, input => ({ output: '<!doctype html><title>Small try</title><h1>Small try</h1>', usage: { input_tokens: Buffer.byteLength(input.input) + 8, output_tokens: 1 } })));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); chmodSync(socket, 0o666); t.after(() => server.close());
  const adapter = new ContainerAdapter(store, { root: join(dir, 'jobs'), gatewaySocket: socket, wallMs: 5_000 });
  const worker = new Worker(store, adapter); worker.reconcile();
  for (let i = 0; i < 40 && store.read('item').state !== 'TRYING'; i++) { await new Promise(resolve => setTimeout(resolve, 250)); worker.reconcile(); }
  assert.equal(store.read('item').state, 'TRYING');
  assert.match(store.artifact('item', store.read('item').context.artifact), /Small try/);
  // A second real container is deliberately long-lived. stop must kill it and fence the ID.
  const hanging = new ContainerAdapter(store, { root: join(dir, 'hang'), gatewaySocket: socket, wallMs: 50,
    command: ['node', '-e', 'setInterval(()=>{},1000)'] });
  const request = { id: runId, item: 'item', approval: 1, spec_hash: store.read('item').context.specHash, cap_micros: 1_000_000,
    spec: { must: ['m'], how_we_know: ['k'], out_of_scope: [] } };
  // The run is no longer active after delivery, so this direct containment probe uses the adapter record only.
  hanging.persist(request); const paths = hanging.paths(request.id); mkdir(paths.out); writeFileSync(paths.spec, JSON.stringify(request.spec));
  hanging.db.prepare("UPDATE container_jobs SET state='running',token_digest=? WHERE id=?").run(null, request.id);
  const cid = sh(hanging.dockerArgs(hanging.row(request.id), paths, 'a'.repeat(43))); assert.ok(cid);
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(hanging.status(request.id).state, 'stopped');
  assert.equal(hanging.stop(request.id).state, 'stopped');
});
