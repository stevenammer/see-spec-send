import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { ContainerAdapter, DockerCli } from '../worker/container.js';
import { main as cli } from '../cli.js';

const dir = t => { const path = mkdtempSync(join(tmpdir(), 'sss-s27-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const ledger = () => ({ mint: (run, _ttl, persist = () => {}) => { persist('c'.repeat(64)); return 'T0ken-'.repeat(8); }, revokeDigest() {} });
const request = { id: 'a'.repeat(64), item: 'item', approval: 1, spec_hash: 'b'.repeat(64), cap_micros: 1, spec: { must: ['m'], how_we_know: ['k'], out_of_scope: [] } };

test('the gateway token reaches docker through its environment, never its arguments', t => {
  const root = dir(t); const store = new Store(join(root, 'db')); t.after(() => store.close());
  const calls = [];
  const docker = { run(args, options = {}) { calls.push({ args, options }); return 'cid'; }, inspect: () => null, kill() {}, remove() {} };
  const adapter = new ContainerAdapter(store, { docker, ledger: ledger(), root, gatewaySocket: join(root, 'sock'), wallMs: 45_000 });
  writeFileSync(join(root, 'sock'), '');
  adapter.start(request);
  const { args, options } = calls[0];
  const token = options.env.SSS_GATEWAY_TOKEN;
  assert.ok(token && token.length >= 32, 'the token must be passed in docker\'s environment');
  assert.equal(args.join(' ').includes(token), false, 'the token must not be an argument');
  assert.ok(args.includes('SSS_GATEWAY_TOKEN'));
});

test('the build deadline also runs inside the container, under an init process', t => {
  const root = dir(t); const store = new Store(join(root, 'db')); t.after(() => store.close());
  const calls = [];
  const docker = { run(args) { calls.push(args); return 'cid'; }, inspect: () => null, kill() {}, remove() {} };
  const adapter = new ContainerAdapter(store, { docker, ledger: ledger(), root, gatewaySocket: join(root, 'sock'), wallMs: 45_000 });
  writeFileSync(join(root, 'sock'), ''); adapter.start(request);
  const args = calls[0]; const image = args.indexOf(adapter.image);
  assert.deepEqual(args.slice(image + 1, image + 5), ['timeout', '-s', 'KILL', '45']);
  assert.ok(args.slice(0, image).includes('--init'), 'busybox timeout needs an init process to enforce its limit');
});

test('every docker call has a timeout, so a hung daemon cannot hang the worker', t => {
  const root = dir(t); const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nsleep 20\n'); chmodSync(join(bin, 'docker'), 0o755);
  const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`; t.after(() => { process.env.PATH = saved; });
  const started = Date.now();
  assert.throws(() => new DockerCli({ timeoutMs: 300 }).run(['ps']));
  assert.ok(Date.now() - started < 5000, 'the call must stop at its timeout');
});

test('the CLI worker and gateway commands refuse unsafe or incomplete input', async t => {
  const root = dir(t); const file = join(root, 'db.sqlite'); const env = { SSS_DB: file };
  const out = []; const write = value => out.push(value);
  await cli(['init'], env, write);
  await assert.rejects(cli(['worker', '--builder', 'container', '--once'], env, write), /--gateway-socket/);
  await assert.rejects(cli(['worker', '--builder', 'process', '--once'], env, write), /--builder must be container/);
  await assert.rejects(cli(['gateway', 'serve', '--fixture'], env, write), /--socket/);
  const loose = join(root, 'loose'); mkdirSync(loose); chmodSync(loose, 0o777);
  // Run it as a real process with a time limit: if the check were missing, `gateway serve` would start listening and never return.
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'gateway', 'serve', '--fixture', '--socket', join(loose, 'g.sock')],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 8000 });
  assert.match(`${run.stdout}${run.stderr}`, /writable by others/);
  assert.notEqual(run.status, 0);
});
