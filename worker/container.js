import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Ledger, digest as capabilityDigest } from '../gateway/ledger.js';
import { HTML_CAP, validateHtml } from './builder/index.js';
import { readProviders } from '../provider/config.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const terminal = state => ['stopped', 'failed'].includes(state);
const validId = value => /^[a-f0-9]{64}$/.test(value);

// The builder's output is untrusted bytes written by a container. Open it without following links,
// accept only a regular file, check its size before reading, and never read more than the cap.
export function readApprovedOutput(path, cap = HTML_CAP) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw Error('output could not be opened without following links');
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw Error('output is not a regular file');
    if (info.size > cap) throw Error('output exceeds the cap before reading');
    const buffer = Buffer.alloc(cap + 1);
    const read = readSync(fd, buffer, 0, cap + 1, 0);
    if (read > cap) throw Error('output exceeds the cap while reading');
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// Every docker call has a timeout, so a hung daemon cannot hang the worker. A secret goes in `env`,
// never in `args`, so it does not show in the host process list.
export const DOCKER_TIMEOUT_MS = 20_000;
export class DockerCli {
  constructor({ timeoutMs = DOCKER_TIMEOUT_MS } = {}) { this.timeoutMs = timeoutMs; }
  run(args, { env = {} } = {}) {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: this.timeoutMs, env: { ...process.env, ...env } }).trim();
  }
  inspect(name) { try { return JSON.parse(this.run(['inspect', name]))[0] || null; } catch { return null; } }
  kill(name) { try { this.run(['kill', name]); } catch {} }
  remove(name) { try { this.run(['rm', '-f', name]); } catch {} }
}

export function pinnedImage(file = new URL('./builder-image.digest', import.meta.url)) {
  const value = readFileSync(file, 'utf8').trim();
  if (!/^(node:22-alpine|alpine)@sha256:[a-f0-9]{64}$/.test(value)) throw Error('builder image digest is invalid');
  return value;
}

// The gateway is a Unix socket bind mount. Docker has no network namespace for the
// builder, so the socket is the sole model-text channel and is not a general egress path.
export class ContainerAdapter {
  constructor(store, { docker = new DockerCli(), ledger = new Ledger(store), root = null,
    gatewaySocket = null, gatewayModel = null, providerName = null, providerOrg = 'default', providerEnv = process.env, imageFile, wallMs = 30_000, now = Date.now, command = ['node', '/builder/index.js'] } = {}) {
    this.store = store; this.db = store.db; this.docker = docker; this.ledger = ledger; this.now = now;
    this.externalStart = true;
    this.modelOutput = true;
    this.wallMs = wallMs;
    this.timers = new Map();
    this.root = resolve(root || join(process.cwd(), '.sss-builder'));
    this.gatewaySocket = gatewaySocket;
    const configured = providerName || readProviders(providerEnv).defaults[providerOrg];
    const provider = configured && readProviders(providerEnv).providers.find(entry => entry.name === configured && entry.enabled);
    if (configured && !provider) throw Error('configured provider is not enabled');
    this.gatewayModel = gatewayModel || provider?.model || 'fixture:text-v1';
    this.command = command;
    this.image = pinnedImage(imageFile);
  }

  paths(id) {
    if (!validId(id)) throw Error('invalid stable run id');
    const root = join(this.root, id);
    return { root, spec: join(root, 'spec.json'), out: join(root, 'out'), html: join(root, 'out', 'try.html') };
  }
  name(id) { return `sss-builder-${id.slice(0, 24)}`; }
  row(id) { return this.db.prepare('SELECT * FROM container_jobs WHERE id=?').get(id); }
  expired(row) { return this.now() >= row.deadline; }
  update(id, state, error = null) { this.db.prepare('UPDATE container_jobs SET state=?,error=? WHERE id=?').run(state, error, id); }
  arm(row) {
    if (this.timers.has(row.id)) return;
    const timer = setTimeout(() => this.stop(row.id), Math.max(0, row.deadline - this.now()));
    timer.unref(); this.timers.set(row.id, timer);
  }
  disarm(id) { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }
  persist(request) {
    const input = JSON.stringify(request);
    const old = this.row(request.id);
    if (old && old.input !== input) throw Error('run id reused with different input');
    if (old) return old;
    const paths = this.paths(request.id);
    const name = this.name(request.id);
    this.db.prepare('INSERT INTO container_jobs VALUES(?,?,?,?,?,?,?,NULL)')
      .run(request.id, input, 'queued', name, null, this.now() + this.wallMs, paths.html);
    return this.row(request.id);
  }
  dockerArgs(row, paths, token) {
    const builder = resolve(new URL('./builder/', import.meta.url).pathname);
    return ['run', '-d', '--name', row.container_name, '--network', 'none', '--read-only',
      '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '32',
      '--cpus', '0.50', '--memory', '64m', '--memory-swap', '64m', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
      '--mount', `type=bind,src=${paths.spec},dst=/work/spec.json,readonly`,
      '--mount', `type=bind,src=${paths.out},dst=/out`,
      '--mount', `type=bind,src=${builder},dst=/builder,readonly`,
      '--mount', `type=bind,src=${this.gatewaySocket},dst=/gateway/gateway.sock,readonly`,
      '--env', 'SSS_GATEWAY_SOCKET=/gateway/gateway.sock', '--env', 'SSS_GATEWAY_TOKEN', // value comes from docker's own environment
      '--env', `SSS_GATEWAY_MODEL=${this.gatewayModel}`,
      this.image, ...this.command];
  }
  // The deadline also runs inside the container: if the worker dies, the build is killed there on its own.
  withDeadline(args) {
    const seconds = Math.max(1, Math.ceil(this.wallMs / 1000));
    // --init matters: busybox timeout does not enforce its limit when it is the container's first process.
    const at = args.indexOf(this.image);
    return [...args.slice(0, at), '--init', this.image, 'timeout', '-s', 'KILL', String(seconds), ...args.slice(at + 1)];
  }
  start(request) {
    let row = this.persist(request); // This SQLite write happens before filesystem, mint, or Docker effects.
    if (terminal(row.state) || row.state === 'ready') return;
    if (this.expired(row)) return this.stop(request.id);
    // A repeated start for a live run resumes it. After a crash between minting and launching,
    // adopt the container if it exists, otherwise revoke the orphaned token and launch again.
    if (row.state === 'running') return;
    if (row.state === 'starting') {
      if (this.docker.inspect(row.container_name)) { this.update(request.id, 'running'); this.arm(this.row(request.id)); return; }
      if (row.token_digest) this.ledger.revokeDigest(row.token_digest);
    }
    const paths = this.paths(request.id);
    // UID 65532 needs only this file and this directory. The output is write-only
    // to other host users, while the worker owns the containing job directory.
    // The sticky bit keeps the builder from replacing or deleting files the worker placed here.
    mkdirSync(paths.out, { recursive: true, mode: 0o1733 }); chmodSync(paths.out, 0o1733);
    if (!existsSync(paths.spec)) {
      writeFileSync(paths.spec, JSON.stringify(request.spec), { mode: 0o444, flag: 'wx' }); chmodSync(paths.spec, 0o444);
    }
    if (!this.gatewaySocket) throw Error('container gateway Unix socket is required');
    const token = this.ledger.mint(request.id, Math.min(this.wallMs, 15 * 60_000), digest => {
      this.db.prepare("UPDATE container_jobs SET state='starting',token_digest=? WHERE id=?").run(digest, request.id);
    });
    const tokenDigest = capabilityDigest(token);
    try {
      const id = this.docker.run(this.withDeadline(this.dockerArgs(row, paths, token)), { env: { SSS_GATEWAY_TOKEN: token } });
      if (!id) throw Error('docker did not return a container id');
      this.update(request.id, 'running'); this.arm(this.row(request.id));
    } catch (error) {
      this.ledger.revokeDigest(tokenDigest); this.update(request.id, 'failed', 'container did not start'); throw error;
    }
  }
  status(id) {
    const row = this.row(id); if (!row) return { state: 'missing' };
    if (row.state === 'ready') return { state: 'ready', html: validateHtml(readApprovedOutput(row.output_path)) };
    if (terminal(row.state)) return { state: row.state };
    if (this.expired(row)) return this.stop(id);
    const info = this.docker.inspect(row.container_name);
    if (!info?.State?.Running) {
      if (info?.State?.ExitCode === 0 && existsSync(row.output_path)) {
        try { const html = validateHtml(readApprovedOutput(row.output_path)); this.disarm(id); this.revoke(row); this.update(id, 'ready'); return { state: 'ready', html }; }
        catch { /* terminal failure below */ }
      }
      this.disarm(id); this.revoke(row); this.update(id, 'failed', 'container exited without a valid artifact'); return { state: 'failed' };
    }
    return { state: 'running' };
  }
  revoke(row) { if (row.token_digest) this.ledger.revokeDigest(row.token_digest); }
  stop(id) {
    const row = this.row(id);
    if (!row) { this.db.prepare('INSERT INTO container_jobs VALUES(?,?,?,?,?,?,?,?)')
      .run(id, '', 'stopped', this.name(id), null, this.now(), this.paths(id).html, 'stop before start'); return { state: 'stopped' }; }
    if (row.state === 'stopped') return { state: 'stopped' };
    this.disarm(id); this.update(id, 'stop_requested'); this.revoke(row); this.docker.kill(row.container_name); this.docker.remove(row.container_name);
    this.update(id, 'stopped'); return { state: 'stopped' };
  }
}
