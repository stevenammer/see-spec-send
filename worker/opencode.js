import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DockerCli, pinnedImage } from './container.js';
import { Ledger, digest as capabilityDigest } from '../gateway/ledger.js';
import { approvedBuildInput } from './builder/index.js';
import { bundleArtifact, composeBundleDocument, validateBundle } from './bundle.js';

const valid = value => /^[a-f0-9]{64}$/.test(value || '');
const terminal = value => ['stopped', 'failed'].includes(value);
const fail = value => { throw Error(`opencode refused: ${value}`); };

// OpenCode is deliberately an opt-in profile. Its image owns /entrypoint.sh, which starts
// a Unix-socket-to-127.0.0.1 forwarder and OpenCode. The agent receives no provider key.
export class OpenCodeAdapter {
  constructor(store, { docker = new DockerCli(), ledger = new Ledger(store), root = null, gatewaySocket = null, imageFile = new URL('./opencode-image.digest', import.meta.url), wallMs = 30_000, now = Date.now, providerMode = 'gateway', limits = {} } = {}) {
    if (providerMode !== 'gateway') fail('spend not enforced: agents holding their own provider key are refused for paid modes');
    // An agent needs more room than the one-shot static builder: it is a real process tree that keeps a
    // session database and logs in /tmp. Everything else about the lock-down is unchanged.
    this.limits = { pids: '256', cpus: '1.00', memory: '1g', tmp: '128m', ...limits };
    this.store = store; this.db = store.db; this.docker = docker; this.ledger = ledger; this.gatewaySocket = gatewaySocket; this.wallMs = wallMs; this.now = now;
    this.root = resolve(root || join(process.cwd(), '.sss-opencode')); this.image = pinnedImage(imageFile, /^sha256:[a-f0-9]{64}$/); this.externalStart = true; this.modelOutput = true; this.timers = new Map();
  }
  paths(id) { if (!valid(id)) fail('invalid run id'); const root = join(this.root, id); return { root, work: join(root, 'work'), bundle: join(root, 'work', 'bundle'), manifest: join(root, 'work', 'manifest.json'), prompt: join(root, 'work', 'PROMPT.txt'), config: join(root, 'work', 'opencode.json') }; }
  name(id) { return `sss-opencode-${id.slice(0, 24)}`; }
  row(id) { return this.db.prepare('SELECT * FROM opencode_jobs WHERE id=?').get(id); }
  update(id, state, error = null) { this.db.prepare('UPDATE opencode_jobs SET state=?,error=? WHERE id=?').run(state, error, id); }
  expired(row) { return this.now() >= row.deadline; }
  arm(row) { if (this.timers.has(row.id)) return; const timer = setTimeout(() => this.stop(row.id), Math.max(0, row.deadline - this.now())); timer.unref(); this.timers.set(row.id, timer); }
  disarm(id) { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }
  persist(request) { const input = JSON.stringify(request); const old = this.row(request.id); if (old && old.input !== input) fail('run id reused with different input'); if (old) return old; const paths = this.paths(request.id); this.db.prepare('INSERT INTO opencode_jobs VALUES(?,?,?,?,?,?,?,NULL)').run(request.id, input, 'queued', this.name(request.id), null, this.now() + this.wallMs, paths.bundle); return this.row(request.id); }
  config(request, token) { const spec = approvedBuildInput({ ...request.spec, ...(request.instructions?.length ? { instructions: request.instructions.map(row => row.instruction) } : {}) }); return { $schema: 'https://opencode.ai/config.json', provider: { sss: { npm: '@ai-sdk/openai-compatible', name: 'Metered gateway', options: { baseURL: 'http://127.0.0.1:8787/v1', apiKey: token }, models: { [process.env.SSS_GATEWAY_MODEL || 'fixture:text-v1']: { name: process.env.SSS_GATEWAY_MODEL || 'fixture:text-v1' } } } }, permission: { edit: 'allow', bash: 'deny', webfetch: 'deny' }, _sss_approved_spec: spec }; }
  dockerArgs(row, paths) { return ['run', '-d', '--name', row.container_name, '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', this.limits.pids, '--cpus', this.limits.cpus, '--memory', this.limits.memory, '--memory-swap', this.limits.memory, '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${this.limits.tmp}`, '--mount', `type=bind,src=${paths.work},dst=/work`, '--mount', `type=bind,src=${this.gatewaySocket},dst=/gateway/gateway.sock,readonly`, '--env', 'SSS_GATEWAY_TOKEN', '--env', 'SSS_GATEWAY_SOCKET=/gateway/gateway.sock', this.image, '/entrypoint.sh']; }
  withDeadline(args) { const at = args.indexOf(this.image); return [...args.slice(0, at), '--init', this.image, 'timeout', '-s', 'KILL', String(Math.max(1, Math.ceil(this.wallMs / 1000))), ...args.slice(at + 1)]; }
  start(request) { let row = this.persist(request); if (terminal(row.state) || row.state === 'ready') return; if (this.expired(row)) return this.stop(request.id); if (row.state === 'running') return; if (row.state === 'starting') { if (this.docker.inspect(row.container_name)) { this.update(request.id, 'running'); this.arm(this.row(request.id)); return; } if (row.token_digest) this.ledger.revokeDigest(row.token_digest); }
    if (!this.gatewaySocket) fail('container gateway Unix socket is required'); const paths = this.paths(request.id); mkdirSync(paths.bundle, { recursive: true, mode: 0o777 }); chmodSync(paths.work, 0o777); chmodSync(paths.bundle, 0o777); const token = this.ledger.mint(request.id, Math.min(this.wallMs, 15 * 60_000), digest => this.db.prepare("UPDATE opencode_jobs SET state='starting',token_digest=? WHERE id=?").run(digest, request.id));
    try { writeFileSync(paths.config, JSON.stringify(this.config(request, token)), { mode: 0o644, flag: 'wx' }); writeFileSync(paths.prompt, JSON.stringify(approvedBuildInput({ ...request.spec, ...(request.instructions?.length ? { instructions: request.instructions.map(row => row.instruction) } : {}) })), { mode: 0o644, flag: 'wx' }); const id = this.docker.run(this.withDeadline(this.dockerArgs(row, paths)), { env: { SSS_GATEWAY_TOKEN: token } }); if (!id) throw Error('docker did not return a container id'); this.update(request.id, 'running'); this.arm(this.row(request.id)); } catch (error) { this.ledger.revokeDigest(capabilityDigest(token)); this.update(request.id, 'failed', 'container did not start'); throw error; }
  }
  ready(row, manifest) { const checked = validateBundle(row.bundle_root, manifest); const bytes = new Map(checked.manifest.files.map(entry => [entry.path, readFileSync(join(row.bundle_root, entry.path))])); const read = path => bytes.get(path); return { state: 'ready', bundle: checked.manifest, html: composeBundleDocument(checked.manifest, path => read(path).toString('utf8')), bundleArtifact: bundleArtifact(checked, read) }; }
  status(id) { const row = this.row(id); if (!row) return { state: 'missing' }; const paths = this.paths(id); if (row.state === 'ready') return this.ready(row, JSON.parse(readFileSync(paths.manifest, 'utf8'))); if (terminal(row.state)) return { state: row.state }; if (this.expired(row)) return this.stop(id); const info = this.docker.inspect(row.container_name); if (!info?.State?.Running) { if (info?.State?.ExitCode === 0 && existsSync(paths.manifest)) { try { const result = this.ready(row, JSON.parse(readFileSync(paths.manifest, 'utf8'))); this.disarm(id); this.revoke(row); this.update(id, 'ready'); return result; } catch {} } this.disarm(id); this.revoke(row); this.update(id, 'failed', 'container exited without a valid bundle'); return { state: 'failed' }; } return { state: 'running' }; }
  revoke(row) { if (row.token_digest) this.ledger.revokeDigest(row.token_digest); }
  stop(id) { let row = this.row(id); if (!row) { const paths = this.paths(id); this.db.prepare('INSERT INTO opencode_jobs VALUES(?,?,?,?,?,?,?,?)').run(id, '', 'stopped', this.name(id), null, this.now(), paths.bundle, 'stop before start'); return { state: 'stopped' }; } if (row.state === 'stopped') return { state: 'stopped' }; this.disarm(id); this.update(id, 'stop_requested'); this.revoke(row); this.docker.kill(row.container_name); this.docker.remove(row.container_name); this.update(id, 'stopped'); return { state: 'stopped' }; }
}
