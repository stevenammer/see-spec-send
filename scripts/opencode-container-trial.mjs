// Live trial: OpenCode inside the locked container, every model call through the metered gateway
// on a Unix socket, Amazon Nova as the upstream. One synthetic task, nothing real.
//   node scripts/opencode-container-trial.mjs     (AWS_* credentials from the environment)
import { chmodSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { Ledger, fixturePolicy, priceRate } from '../gateway/ledger.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider } from '../gateway/fixture.js';
import { bedrockConverse } from '../provider/bedrock.js';
import { OpenCodeAdapter } from '../worker/opencode.js';
import { DockerCli } from '../worker/container.js';

if (!process.env.AWS_ACCESS_KEY_ID) { console.error('AWS credentials required in the environment'); process.exit(2); }
process.env.SSS_GATEWAY_MODEL = 'nova-lite';
const dir = mkdtempSync(join(tmpdir(), 'sss-ocx-'));
const store = new Store(join(dir, 'trial.db'));
store.registerPerson('op'); store.registerPerson('leader', { leader: true });
let seq = 0; const at = () => new Date().toISOString();
const append = event => store.append('trial', { ...event, at: at() }, { idem: `ocx:${seq++}` });
append({ type: 'posted', actor: 'op', rules: 2, original: 'Synthetic note page.' });
append({ type: 'specced', actor: 'op', see_hash: store.read('trial').context.seeHash,
  must: ['A page titled Transfer note', 'A textarea that saves its text to localStorage', 'Separate index.html, style.css and app.js files linked together'],
  how_we_know: ['Typing in the box and reloading keeps the text'], out_of_scope: ['Any network request'] });
const spec_hash = store.read('trial').context.specHash;
const packet_hash = store.putArtifact('trial', JSON.stringify({ specHash: spec_hash }));
append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, reason: 'Synthetic container trial.', cap_usd: 1, quorum: 1, window_minutes: 60, max_iterations: 1 });
new Worker(store, { start() {}, status: () => ({ state: 'running' }), stop: () => ({ state: 'stopped' }) }).reconcile();
const run = store.db.prepare("SELECT * FROM runs WHERE status='active'").get();
const rate = priceRate({ model: 'nova-lite', inputMicrosPerMillion: 60_000, outputMicrosPerMillion: 240_000, framingTokens: 64 });
const ledger = new Ledger(store, { rate });
ledger.configure(fixturePolicy({ input_bytes: 600_000, output_tokens: 8_192, response_bytes: 1_000_000, timeout_ms: 180_000,
  max_calls_per_run: Number(process.env.TRIAL_MAX_CALLS || 40), max_tokens_per_run: 2_000_000, concurrency: 4 }));
const provider = bedrockConverse({ region: process.env.AWS_REGION || 'us-east-1', modelId: 'us.amazon.nova-lite-v1:0',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN } });
// Diagnostics only: shapes and error text, never keys or message content.
const traced = { async chat(request, meta) {
  try { return await provider.chat(request, meta); }
  catch (e) { console.error('upstream-error', String(e.message).slice(0, 300), 'tools', request.tools?.length, 'messages', request.messages?.length); throw e; }
} };
const server = createGatewayServer(new Gateway(ledger, fixtureProvider), new ChatGateway(ledger, traced));
const socket = join(dir, 'gw.sock');
await new Promise(resolve => server.listen(socket, resolve)); chmodSync(socket, 0o666);
const adapter = new OpenCodeAdapter(store, { docker: new DockerCli({ timeoutMs: 60_000 }), ledger, root: join(dir, 'runs'), gatewaySocket: socket, wallMs: Number(process.env.TRIAL_WALL_MS || 240_000) });
const spec = { must: store.events('trial').find(e => e.type === 'specced').must, how_we_know: ['Typing in the box and reloading keeps the text'], out_of_scope: ['Any network request'] };
adapter.start({ id: run.id, spec, instructions: [] });
console.log('started', run.id.slice(0, 12), 'dir', dir);
let status = adapter.status(run.id); const t0 = Date.now();
while (status.state === 'running' && Date.now() - t0 < 300_000) { await new Promise(r => setTimeout(r, 3000)); status = adapter.status(run.id); }
const receipts = ledger.receipts();
console.log(JSON.stringify({ state: status.state, files: status.bundle?.files?.map(f => `${f.path}:${f.bytes}`),
  receipts: receipts.length, settled: receipts.filter(r => r.state === 'settled').length,
  input_tokens: receipts.reduce((n, r) => n + (r.usage ? JSON.parse(r.usage).input_tokens || 0 : 0), 0),
  output_tokens: receipts.reduce((n, r) => n + (r.usage ? JSON.parse(r.usage).output_tokens || 0 : 0), 0) }));
try { console.log(String(new DockerCli().run(['logs', '--tail', '40', adapter.name(run.id)]))); } catch {}
adapter.stop(run.id); server.close(); store.close();
