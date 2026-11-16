// Live trial: run a real coding agent (OpenCode) through the metered chat proxy.
// Nothing here is a benchmark. It answers one question: do the proxy and its
// per-run ceilings hold up under a real multi-call tool-using agent?
//
//   GEMINI_API_KEY=... node scripts/builder-trial.mjs /path/to/opencode "task text"
//
// The key is read from the environment only and never printed or stored.
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { Ledger, fixturePolicy, priceRate } from '../gateway/ledger.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider } from '../gateway/fixture.js';
import { openAICompatible } from '../provider/adapters.js';
import { bedrockConverse } from '../provider/bedrock.js';

const [bin, task] = [process.argv[2], process.argv[3]];
// TRIAL_PROVIDER=bedrock uses Amazon Nova through the Converse API (AWS_* credentials from the
// environment); the default is Gemini's OpenAI-compatible endpoint (GEMINI_API_KEY).
const useBedrock = process.env.TRIAL_PROVIDER === 'bedrock';
const model = process.env.TRIAL_MODEL || (useBedrock ? 'nova-lite' : 'gemini-2.5-flash');
if (!bin || !task || (!useBedrock && !process.env.GEMINI_API_KEY) || (useBedrock && !process.env.AWS_ACCESS_KEY_ID)) { console.error('usage: [TRIAL_PROVIDER=bedrock] node scripts/builder-trial.mjs OPENCODE_BIN "task"'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'sss-trial-'));
const store = new Store(join(dir, 'trial.db'));
store.registerPerson('op'); store.registerPerson('leader', { leader: true });
let seq = 0; const at = () => new Date().toISOString();
const append = event => store.append('trial', { ...event, at: at() }, { idem: `trial:${seq++}` });
append({ type: 'posted', actor: 'op', rules: 2, original: 'Synthetic trial task.' });
append({ type: 'specced', actor: 'op', see_hash: store.read('trial').context.seeHash, must: ['Do the task'], how_we_know: ['A file exists'], out_of_scope: [] });
const spec_hash = store.read('trial').context.specHash;
const packet_hash = store.putArtifact('trial', JSON.stringify({ specHash: spec_hash }));
append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, reason: 'Synthetic trial on a free model lane.', cap_usd: 1, quorum: 1, window_minutes: 60, max_iterations: 1 });
new Worker(store, { start() {}, status: () => ({ state: 'running' }), stop: () => ({ state: 'stopped' }) }).reconcile();
// Nova Lite list price: $0.06 / $0.24 per million tokens. Gemini free tier: zero.
const rate = priceRate({ model, inputMicrosPerMillion: useBedrock ? 60_000 : 0, outputMicrosPerMillion: useBedrock ? 240_000 : 0, framingTokens: 64 });
const ledger = new Ledger(store, { rate });
const MAX_CALLS = Number(process.env.TRIAL_MAX_CALLS || 40);
ledger.configure(fixturePolicy({ input_bytes: 600_000, output_tokens: 16_384, response_bytes: 1_000_000, timeout_ms: 180_000,
  max_calls_per_run: MAX_CALLS, max_tokens_per_run: 2_000_000, concurrency: 4 }));
const provider = useBedrock ? bedrockConverse({ region: process.env.AWS_REGION || 'us-east-1', modelId: 'us.amazon.nova-lite-v1:0',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN } })
  : openAICompatible({ url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  apiKey: process.env.GEMINI_API_KEY, hosts: ['generativelanguage.googleapis.com'], timeoutMs: 180_000,
  requestBytes: 700_000, responseBytes: 1_000_000 });
// Diagnostics only: shapes and sizes, never keys or message text.
const traced = { async chat(request, meta) {
  try {
    const result = await provider.chat(request, meta);
    if (request.stream) return (async function* () { let n = 0, usage = false; try { for await (const chunk of result) { n += 1; if (chunk?.usage) usage = true; yield chunk; } } catch (e) { console.error('upstream-stream-error', String(e.message).slice(0, 200)); throw e; } console.error('stream-done chunks', n, 'usage', usage); })();
    console.error('call-done usage', JSON.stringify(result?.usage)); return result;
  } catch (e) { console.error('upstream-error', String(e.message).slice(0, 300)); throw e; }
} };
const server = createGatewayServer(new Gateway(ledger, fixtureProvider), new ChatGateway(ledger, traced));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const run = store.db.prepare("SELECT * FROM runs WHERE status='active'").get();
const token = ledger.mint(run.id);
const work = join(dir, 'work'); (await import('node:fs')).mkdirSync(work);
writeFileSync(join(work, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
  provider: { sss: { npm: '@ai-sdk/openai-compatible', name: 'Metered gateway',
    options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: token },
    models: { [model]: { name: model, tool_call: true, limit: { context: 200_000, output: 8192 } } } } },
  permission: { edit: 'allow', bash: 'deny', webfetch: 'deny' } }));
// OpenCode takes a non-git directory's project root to be /, so give it a real root.
execFileSync('git', ['init', '-q'], { cwd: work });
console.log(`trial dir ${dir}; max calls ${MAX_CALLS}`);
const child = spawn(bin, ['run', '--print-logs', '-m', `sss/${model}`, task], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb' } });
let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.TRIAL_TIMEOUT_MS || 300_000));
await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer);
const receipts = ledger.receipts();
const summary = { receipts: receipts.length, states: Object.fromEntries([...new Set(receipts.map(r => r.state))].map(s => [s, receipts.filter(r => r.state === s).length])),
  input_tokens: receipts.reduce((n, r) => n + (r.usage ? JSON.parse(r.usage).input_tokens || 0 : 0), 0),
  output_tokens: receipts.reduce((n, r) => n + (r.usage ? JSON.parse(r.usage).output_tokens || 0 : 0), 0),
  files: readdirSync(work).filter(f => f !== 'opencode.json') };
console.log(JSON.stringify(summary), 'exit', child.exitCode, child.signalCode, 'outlen', out.length);
console.log(out.split('\n').join('\n').slice(-3500));
server.close(); store.close();
