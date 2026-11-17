// Builder evaluation.
//   PLAYWRIGHT_DIR=/path/to/node_modules node scripts/builder-eval.mjs --selftest
//   PLAYWRIGHT_DIR=... GEMINI_API_KEY=... node scripts/builder-eval.mjs --run --provider gemini --model gemini-2.5-flash
//     [--builder opencode|claude-code|codex] [--tasks refunds,swaps,triage] [--repeat 1] [--wall-ms 300000] [--max-calls 40] [--out results.jsonl]
// Providers: gemini and groq (free tiers, keys from the environment) and bedrock (AWS_* from the environment, paid).
// For each task it judges a hand-written good bundle (must pass every check, and pass the host's own bundle validator)
// and a deliberately broken one (must fail at least one check). A judge that can't tell those apart proves nothing
// about a model's build. Run mode (a real builder and model) is added on top of this.
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tasks } from '../eval/builder/tasks.mjs';
import { judgeBundle, manifestFor } from '../eval/builder/judge.mjs';
import { validateBundle } from '../worker/bundle.js';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { Ledger, fixturePolicy, priceRate } from '../gateway/ledger.js';
import { Gateway, ChatGateway, createGatewayServer } from '../gateway/http.js';
import { fixtureProvider } from '../gateway/fixture.js';
import { openAICompatible } from '../provider/adapters.js';
import { bedrockConverse } from '../provider/bedrock.js';
import { OpenCodeAdapter } from '../worker/opencode.js';
import { ClaudeCodeAdapter } from '../worker/claudecode.js';
import { CodexAdapter } from '../worker/codex.js';
import { DockerCli } from '../worker/container.js';

function write(root, files) { for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); } }

async function selftest() {
  let bad = 0;
  for (const task of tasks) {
    const good = mkdtempSync(join(tmpdir(), `sss-judge-${task.id}-good-`)); write(good, task.oracle);
    try { validateBundle(good, manifestFor(good)); } catch (error) { console.log(`FAIL ${task.id}: the good bundle is not shippable by the host validator (${error.message})`); bad += 1; }
    const goodResult = await judgeBundle(good, task);
    if (!goodResult.ok) { console.log(`FAIL ${task.id}: the good bundle failed: ${goodResult.checks.filter(c => !c.ok).map(c => c.name).join('; ')}`); bad += 1; }
    const [file, from, to] = task.broken.patch;
    if (!task.oracle[file].includes(from)) { console.log(`FAIL ${task.id}: the break does not apply`); bad += 1; continue; }
    const broken = mkdtempSync(join(tmpdir(), `sss-judge-${task.id}-bad-`)); write(broken, { ...task.oracle, [file]: task.oracle[file].replace(from, to) });
    const brokenResult = await judgeBundle(broken, task);
    if (brokenResult.ok) { console.log(`FAIL ${task.id}: the broken bundle passed every check`); bad += 1; }
    console.log(`${task.id}: good ${goodResult.passed}/${goodResult.total}, broken ${brokenResult.passed}/${brokenResult.total} (caught by: ${brokenResult.checks.filter(c => !c.ok).map(c => c.name).join('; ')})`);
  }
  if (bad) { console.log(`${bad} problem(s)`); process.exit(1); }
  console.log('the judge tells good from broken on every task');
}

const arg = (name, fallback = null) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };

// List prices per million tokens, in micro-dollars. Free tiers are zero. They only feed the spend meter, and they
// are set at or above the real price so a cap holds even if a price drifts.
const PRICES = {
  'nova-lite': [60_000, 240_000], 'nova-pro': [800_000, 3_200_000], 'claude-sonnet': [3_000_000, 15_000_000], 'claude-haiku': [1_000_000, 5_000_000],
};
const BEDROCK_IDS = { 'nova-lite': 'us.amazon.nova-lite-v1:0', 'nova-pro': 'us.amazon.nova-pro-v1:0', 'claude-haiku': 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-sonnet': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' };

function providerFor(name, model) {
  if (name === 'gemini') {
    if (!process.env.GEMINI_API_KEY) throw Error('GEMINI_API_KEY is not set');
    return { upstream: openAICompatible({ url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: process.env.GEMINI_API_KEY,
      hosts: ['generativelanguage.googleapis.com'], timeoutMs: 180_000, requestBytes: 700_000, responseBytes: 1_000_000 }), rate: [0, 0], label: model };
  }
  if (name === 'groq') {
    if (!process.env.GROQ_API_KEY) throw Error('GROQ_API_KEY is not set');
    return { upstream: openAICompatible({ url: 'https://api.groq.com/openai/v1/chat/completions', apiKey: process.env.GROQ_API_KEY,
      hosts: ['api.groq.com'], timeoutMs: 180_000, requestBytes: 700_000, responseBytes: 1_000_000 }), rate: [0, 0], label: model };
  }
  if (name === 'bedrock') {
    if (!process.env.AWS_ACCESS_KEY_ID) throw Error('AWS credentials are not set');
    const id = BEDROCK_IDS[model] || model;
    return { upstream: bedrockConverse({ region: process.env.AWS_REGION || 'us-east-1', modelId: id,
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN } }),
      rate: PRICES[model] || PRICES['claude-sonnet'], label: model };
  }
  throw Error(`unknown provider ${name}`);
}

async function runOnce({ task, providerName, model, wallMs, maxCalls }) {
  const { upstream, rate: [inMicros, outMicros], label } = providerFor(providerName, model);
  process.env.SSS_GATEWAY_MODEL = label;
  const dir = mkdtempSync(join(tmpdir(), `sss-eval-${task.id}-`));
  const store = new Store(join(dir, 'eval.db'));
  store.registerPerson('op'); store.registerPerson('leader', { leader: true });
  let seq = 0; const append = event => store.append('eval', { ...event, at: new Date().toISOString() }, { idem: `eval:${seq++}` });
  append({ type: 'posted', actor: 'op', rules: 2, original: task.title });
  append({ type: 'specced', actor: 'op', see_hash: store.read('eval').context.seeHash, ...task.spec });
  const spec_hash = store.read('eval').context.specHash;
  const packet_hash = store.putArtifact('eval', JSON.stringify({ specHash: spec_hash }));
  append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
  append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, reason: 'Synthetic builder evaluation.', cap_usd: 1, quorum: 1, window_minutes: 60, max_iterations: 1 });
  new Worker(store, { start() {}, status: () => ({ state: 'running' }), stop: () => ({ state: 'stopped' }) }).reconcile();
  const run = store.db.prepare("SELECT * FROM runs WHERE status='active'").get();
  const ledger = new Ledger(store, { rate: priceRate({ model: label, inputMicrosPerMillion: inMicros, outputMicrosPerMillion: outMicros, framingTokens: 64 }) });
  // The fixture policy's $0.10 day cap is far below one Claude call's worst-case hold. The binding limit here is the approval's $1 run cap.
  ledger.configure(fixturePolicy({ input_bytes: 600_000, output_tokens: 8_192, response_bytes: 1_000_000, timeout_ms: 180_000, max_calls_per_run: maxCalls, max_tokens_per_run: 2_000_000, concurrency: 4, global_micros: 5_000_000, day_micros: 5_000_000 }));
  const errors = [];
  // What the model did on each call: which tools it asked for, why it stopped, and the start of any text. Never keys.
  const turns = [];
  const note = turn => { const pick = turn.tools.length ? `tools ${turn.tools.join(',')}` : 'no tool'; turns.push(`${pick}; finish ${turn.finish}; text ${JSON.stringify(turn.text.slice(0, 140))}`); };
  const traced = { async chat(request, meta) {
    try {
      const result = await upstream.chat(request, meta);
      if (request.stream) return (async function* () { const turn = { tools: [], finish: '?', text: '' }; try { for await (const chunk of result) { const choice = chunk?.choices?.[0]; if (choice?.delta?.content) turn.text += choice.delta.content; for (const call of choice?.delta?.tool_calls || []) if (call.function?.name) turn.tools.push(call.function.name); if (choice?.finish_reason) turn.finish = choice.finish_reason; yield chunk; } } finally { note(turn); } })();
      const choice = result?.choices?.[0]; note({ tools: (choice?.message?.tool_calls || []).map(c => c.function?.name), finish: choice?.finish_reason || '?', text: String(choice?.message?.content || '') });
      return result;
    } catch (error) { errors.push(String(error.message).slice(0, 160)); throw error; }
  } };
  const server = createGatewayServer(new Gateway(ledger, fixtureProvider), new ChatGateway(ledger, traced));
  const socket = join(dir, 'gw.sock');
  await new Promise(resolve => server.listen(socket, resolve)); chmodSync(socket, 0o666);
  // --debug-agent runs the same container but writes the agent's own log to /work/agent.log (the shipped entrypoint
  // discards it). Diagnosis only: the build itself is unchanged.
  const DEBUG_SCRIPT = readFileSync(new URL('../worker/opencode/entrypoint.sh', import.meta.url), 'utf8').replace('opencode run -m', 'opencode run --print-logs -m').replace(/ \|\| true\n/, ' > /work/agent.log 2>&1 || true\n');
  const Base = { 'claude-code': ClaudeCodeAdapter, codex: CodexAdapter }[arg('--builder', 'opencode')] || OpenCodeAdapter;
  class Adapter extends Base { withDeadline(args) { const out = super.withDeadline(args); return process.argv.includes('--debug-agent') ? [...out.slice(0, out.lastIndexOf('/entrypoint.sh')), 'sh', '-c', DEBUG_SCRIPT] : out; } }
  const adapter = new Adapter(store, { docker: new DockerCli({ timeoutMs: 60_000 }), ledger, root: join(dir, 'runs'), gatewaySocket: socket, wallMs });
  const started = Date.now();
  adapter.start({ id: run.id, spec: task.spec, instructions: [] });
  let status = adapter.status(run.id);
  let agentLog = ''; const logger = new DockerCli({ timeoutMs: 15_000 });
  const snapshot = () => { try { const text = String(logger.run(['logs', '--tail', '80', adapter.name(run.id)])); if (text.trim()) agentLog = text.slice(-3000); } catch { /* not running yet or already gone */ } };
  while (status.state === 'running' && Date.now() - started < wallMs + 30_000) { await new Promise(resolve => setTimeout(resolve, 1500)); snapshot(); status = adapter.status(run.id); }
  const seconds = Math.round((Date.now() - started) / 1000);
  const receipts = ledger.receipts();
  const usage = receipts.map(row => (row.usage ? JSON.parse(row.usage) : {}));
  const inputTokens = usage.reduce((n, u) => n + (u.input_tokens || 0), 0), outputTokens = usage.reduce((n, u) => n + (u.output_tokens || 0), 0);
  const costMicros = receipts.reduce((n, row) => n + row.charged_micros, 0);
  const bundle = adapter.paths(run.id).bundle;
  const repairFile = adapter.paths(run.id).repair; const repairReason = existsSync(repairFile) ? readFileSync(repairFile, 'utf8').slice(0, 200) : null;
  const logFile = join(adapter.paths(run.id).work, 'agent.log'); if (existsSync(logFile)) agentLog = readFileSync(logFile, 'utf8').slice(-3500);
  const hostAccepted = status.state === 'ready';
  // The host's own validator decides what a user would ever see. Judge the raw output too when it was refused, so
  // the report can say how good a build was that the product threw away.
  let judged = null;
  if (existsSync(join(bundle, 'index.html'))) { try { judged = await judgeBundle(bundle, task); } catch (error) { judged = { error: String(error.message).slice(0, 160) }; } }
  const files = existsSync(bundle) ? manifestFor(bundle).files.map(f => `${f.path}:${f.bytes}`) : [];
  const refusal = hostAccepted ? null : (() => { try { validateBundle(bundle, manifestFor(bundle)); return null; } catch (error) { return String(error.message).slice(0, 120); } })();
  try { adapter.stop(run.id); } catch { /* already finished */ }
  server.close(); store.close();
  return { task: task.id, builder: arg('--builder', 'opencode'), provider: providerName, model, builder_state: status.state, repaired: Boolean(repairReason), repair_reason: repairReason, host_accepted: hostAccepted, host_refusal: refusal,
    judged: judged && !judged.error ? { passed: judged.passed, total: judged.total, ok: judged.ok, failed: judged.checks.filter(c => !c.ok).map(c => c.name), outside: judged.outside.length, page_errors: judged.errors.length } : judged,
    product_ok: Boolean(hostAccepted && judged && judged.ok), calls: receipts.length, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: Number((costMicros / 1e6).toFixed(4)), seconds, files, upstream_errors: errors.slice(0, 3), turns, agent_log: process.argv.includes('--logs') ? agentLog : undefined, dir };
}

async function runMode() {
  const providerName = arg('--provider'), model = arg('--model');
  if (!providerName || !model) { console.error('--run needs --provider and --model'); process.exit(2); }
  const wanted = (arg('--tasks') || tasks.map(t => t.id).join(',')).split(',');
  const repeat = Number(arg('--repeat', '1')), wallMs = Number(arg('--wall-ms', '300000')), maxCalls = Number(arg('--max-calls', '40'));
  const out = arg('--out'); let spent = 0;
  const budget = Number(arg('--budget-usd', '0'));
  for (const id of wanted) {
    const task = tasks.find(t => t.id === id); if (!task) { console.error(`unknown task ${id}`); process.exit(2); }
    for (let n = 1; n <= repeat; n += 1) {
      if (providerName === 'bedrock' && spent >= budget) { console.log(`stopping: the ${budget} USD budget for this invocation is used up`); return; }
      const result = await runOnce({ task, providerName, model, wallMs, maxCalls }); result.attempt = n; spent += result.cost_usd;
      console.log(JSON.stringify(result));
      if (out) appendFileSync(out, `${JSON.stringify(result)}\n`);
    }
  }
}

// Re-judges bundles an earlier run left on disk, with the current checks. Costs nothing: no model is called.
async function rejudge(files) {
  const rows = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  const out = [];
  for (const row of rows) {
    const task = tasks.find(t => t.id === row.task); const bundle = readdirSync(join(row.dir, 'runs')).map(id => join(row.dir, 'runs', id, 'work', 'bundle')).find(path => existsSync(join(path, 'index.html')));
    let judged = null;
    if (task && bundle) { try { const result = await judgeBundle(bundle, task); judged = { passed: result.passed, total: result.total, ok: result.ok, failed: result.checks.filter(c => !c.ok).map(c => c.name) }; } catch (error) { judged = { error: String(error.message).slice(0, 120) }; } }
    out.push({ ...row, judged, product_ok: Boolean(row.host_accepted && judged && judged.ok) });
  }
  return out;
}

if (process.argv.includes('--rejudge')) {
  const rows = await rejudge(arg('--rejudge').split(','));
  for (const row of rows) { const j = row.judged; console.log(JSON.stringify({ model: row.model, task: row.task, host_accepted: row.host_accepted, judge: j && j.passed !== undefined ? `${j.passed}/${j.total}` : '-', failed: j?.failed, product_ok: row.product_ok, usd: row.cost_usd, calls: row.calls })); }
} else if (process.argv.includes('--selftest')) await selftest();
else if (process.argv.includes('--run')) await runMode();
else { console.error('use --selftest or --run'); process.exit(2); }
