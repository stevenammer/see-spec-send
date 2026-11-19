// Repeatable proof that the metered gateway enforces one UTC-day cap across every model lane.
// ZERO network and ZERO spend: every model call goes to an in-process stand-in that reports token usage. The
// stand-in is priced like Claude Haiku 4.5 on Bedrock (list price $1 per million input tokens, $5 per million output).
// It runs on a throwaway database in a temp directory. The only child process is this repo's own CLI (gateway and
// kill commands), pointed at that throwaway database.
//
//   node scripts/prove-daily-cap.mjs            (exit 1 if any check fails)
//   node scripts/prove-daily-cap.mjs --keep     (leave the temp directory in place and print its path)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { Ledger, priceRate, rateWithSystemText } from '../gateway/ledger.js';
import { providerGateway } from '../gateway/http.js';
import { QuestGateway, QUEST_LIMITS } from '../gateway/quest.js';
import { EffortGateway, EFFORT_LIMITS } from '../gateway/effort.js';
import { AnalysisGateway, ANALYSIS_LIMITS } from '../gateway/analysis.js';
import { killed } from '../worker/control.js';
import { runReset } from '../deploy/hosted-demo/reset.js';
import { SYSTEM_PROMPT } from '../worker/builder/index.js';
import { EFFORT_SYSTEM } from '../effort/prompt.js';
import { SPEC_INSTRUCTIONS } from '../effort/spec.js';
import { QUEST_SYSTEM } from '../provider/vision-quest.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
export const DAY_CAP = 15_000_000;
export const LIFETIME_CAP = 100_000_000;
// Claude Haiku 4.5 on Amazon Bedrock list price, micro-dollars per million tokens (see docs/PROVIDERS.md).
export const HAIKU = { model: 'anthropic.claude-haiku-4-5-20251001-v1:0', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 5_000_000 };
export const PROOF_POLICY = Object.freeze({ enabled: true, global_micros: LIFETIME_CAP, day_micros: DAY_CAP, concurrency: 4,
  input_bytes: 65_536, output_tokens: 4096, response_bytes: 65_536, timeout_ms: 30_000 });
const LANES = ['builder', 'quest', 'effort', 'analysis'];
const usd = micros => `$${(micros / 1_000_000).toFixed(6)}`;
const BIG = 65_536;

export async function proveDailyCap({ log = console.log, keep = false } = {}) {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
    log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` (${detail})` : ''}`);
    return ok;
  };
  const section = title => log(`\n=== ${title} ===`);
  const dir = mkdtempSync(join(tmpdir(), 'sss-prove-cap-'));
  const dbPath = join(dir, 'staging.db');
  const templatePath = join(dir, 'template.db');
  const priorTz = process.env.TZ;
  process.env.TZ = 'America/New_York'; // the day key must not follow the server's local time zone
  const open = [];
  const track = store => { open.push(store); return store; };
  try {
    log(`staging directory: ${dir}`);
    log(`price (Haiku 4.5 on Bedrock): ${HAIKU.inputMicrosPerMillion} / ${HAIKU.outputMicrosPerMillion} micro-dollars per million input / output tokens`);

    // ---------------------------------------------------------------------------------------------------------------
    // Throwaway database: one item approved for a builder run (per-run approved cap $50, far above the day cap, so the
    // day cap is the limit that binds).
    let now = Date.parse('2026-11-19T12:00:00.000Z');
    const clock = () => now;
    {
      const store = new Store(dbPath);
      store.registerPerson('op'); store.registerPerson('leader', { leader: true });
      let seq = 0;
      const append = event => store.append('proof', { ...event, at: new Date(now).toISOString() }, { idem: `proof:${seq++}` });
      append({ type: 'posted', actor: 'op', rules: 2, original: 'Synthetic cap-proof problem.' });
      append({ type: 'specced', actor: 'op', see_hash: store.read('proof').context.seeHash, must: ['Show the note'], how_we_know: ['It shows'], out_of_scope: [] });
      const spec_hash = store.read('proof').context.specHash;
      const packet_hash = store.putArtifact('proof', JSON.stringify({ specHash: spec_hash }));
      append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
      append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, reason: 'Cap proof; the day cap is the limit under test.', cap_usd: 50, quorum: 1, window_minutes: 4320, max_iterations: 2 });
      const adapter = { start() {}, status: () => ({ state: 'running' }), stop: () => ({ state: 'stopped' }) };
      new Worker(store, adapter, { clock }).reconcile();
      store.close();
    }

    // ---------------------------------------------------------------------------------------------------------------
    section('1. Policy through the repo CLI');
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, `${JSON.stringify(PROOF_POLICY, null, 2)}\n`);
    const cliAt = (db, ...args) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, SSS_DB: db, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
      return { code: result.status, out: `${result.stdout}${result.stderr}`.trim() };
    };
    const cli = (...args) => {
      const result = cliAt(dbPath, ...args);
      log(`$ SSS_DB=${dbPath} node cli.js ${args.join(' ')}`);
      log(result.out.split('\n').map(line => `  ${line}`).join('\n'));
      return result;
    };
    const setPolicy = changes => { writeFileSync(policyFile, `${JSON.stringify({ ...PROOF_POLICY, ...changes })}\n`); return cli('gateway', 'policy', 'set', '--file', policyFile); };
    cli('gateway', 'fixture-enable');
    writeFileSync(policyFile, `${JSON.stringify(PROOF_POLICY)}\n`);
    cli('gateway', 'policy', 'set', '--file', policyFile);
    const status = cli('gateway', 'status');
    const shown = JSON.parse(status.out).policy;
    check('policy stored with day_micros 15,000,000 and global_micros 100,000,000', shown.day_micros === DAY_CAP && shown.global_micros === LIFETIME_CAP && shown.enabled === true);
    copyFileSync(dbPath, templatePath); // what a "reset to seed" script would restore: policy present, no receipts

    // ---------------------------------------------------------------------------------------------------------------
    // The stand-in provider. Shaped like the Bedrock adapter (complete -> { text, usage }), counts every call it receives.
    const stub = {
      count: 0, perLane: Object.fromEntries(LANES.map(lane => [lane, 0])), mode: 'max', gate: null, onCall: null,
      adapter(lane) {
        return async ({ system = '', messages, maxOutputTokens }) => {
          stub.count += 1; stub.perLane[lane] += 1;
          const user = messages.map(message => message.content).join('');
          if (stub.onCall) stub.onCall(lane);
          if (stub.gate) await stub.gate;
          const inputBytes = Buffer.byteLength(system) + Buffer.byteLength(user);
          if (stub.mode === 'missing') return { text: 'answer without a usage report' };
          if (stub.mode === 'typical') return { text: 'ok', usage: { inputTokens: Math.ceil(inputBytes / 4), outputTokens: Math.min(maxOutputTokens, 120) } };
          return { text: 'ok', usage: { inputTokens: inputBytes, outputTokens: maxOutputTokens } }; // the full reserved bound
        };
      },
    };

    // One database connection, four lane gateways sharing it. Each lane has its own reviewed rate (system text differs).
    const store = track(new Store(dbPath));
    const base = priceRate({ ...HAIKU, framingTokens: 8 });
    const baseLedger = new Ledger(store, { clock, rate: base });
    const run = store.db.prepare("SELECT * FROM runs WHERE status='active' ORDER BY iteration DESC").get();
    let token = baseLedger.mint(run.id);
    const builder = providerGateway(baseLedger, { complete: stub.adapter('builder') }, { system: SYSTEM_PROMPT });
    const questLedger = new Ledger(store, { clock, rate: rateWithSystemText(base, QUEST_SYSTEM) });
    const quest = new QuestGateway(questLedger, async input => {
      const r = await stub.adapter('quest')({ system: QUEST_SYSTEM, messages: [{ content: input.input }], maxOutputTokens: input.max_output_tokens });
      return { output: r.text, usage: { input_tokens: r.usage?.inputTokens, output_tokens: r.usage?.outputTokens } };
    }, { clock });
    const effortLedger = new Ledger(store, { clock, rate: rateWithSystemText(base, EFFORT_SYSTEM, SPEC_INSTRUCTIONS) });
    const effort = new EffortGateway(effortLedger, async input => {
      const r = await stub.adapter('effort')({ system: EFFORT_SYSTEM, messages: [{ content: input.input }], maxOutputTokens: input.max_output_tokens });
      return { output: r.text, usage: { input_tokens: r.usage?.inputTokens, output_tokens: r.usage?.outputTokens } };
    }, { clock });
    const analysisLedger = new Ledger(store, { clock, rate: base });
    const analysis = new AnalysisGateway(analysisLedger, async input => {
      const r = await stub.adapter('analysis')({ system: '', messages: [{ content: input.input }], maxOutputTokens: input.max_output_tokens });
      return { output: r.text, usage: { input_tokens: r.usage?.inputTokens, output_tokens: r.usage?.outputTokens } };
    }, { clock });

    let uniq = 0;
    const day = () => new Date(now).toISOString().slice(0, 10);
    const totals = (atDay = day()) => {
      const per = {
        builder: baseLedger.receipts(), quest: baseLedger.questReceipts(), effort: baseLedger.effortReceipts(), analysis: baseLedger.analysisReceipts(),
      };
      const sum = rows => rows.filter(row => row.day === atDay).reduce((n, row) => n + row.charged_micros, 0);
      const lanes = Object.fromEntries(Object.entries(per).map(([lane, rows]) => [lane, sum(rows)]));
      const lifetime = Object.values(per).flat().reduce((n, row) => n + row.charged_micros, 0);
      return { day: atDay, lanes, total: Object.values(lanes).reduce((a, b) => a + b, 0), lifetime, rows: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.length])) };
    };
    const bigText = n => 'x'.repeat(n);
    const asks = {
      builder: (who, n = BIG, out = 4096) => builder.call(token, `b-${who}-${uniq++}`, { model: HAIKU.model, input: bigText(n), max_output_tokens: out }).then(r => { if (r.status !== 200) throw Error(`unsettled ${r.status}`); return r; }),
      quest: (who, n = BIG, out = 256) => quest.call(who, `q-${who}-${uniq++}`, { model: HAIKU.model, input: bigText(n), max_output_tokens: out }),
      effort: (who, n = BIG, out = 256, item = `item-${who}`) => effort.call(who, `e-${who}-${item}-${uniq++}`, { model: HAIKU.model, input: bigText(n), max_output_tokens: out }, item, `job-${who}-${item}`),
      analysis: (who, n = BIG, out) => analysis.ask(who, `a-${who}-${uniq++}`, { p: bigText(n - 8) }),
    };
    const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, message: String(error.message), kind: error.kind };  } };

    // ---------------------------------------------------------------------------------------------------------------
    section('2b. Worst case is reserved BEFORE the call; a response with no usage keeps the full hold');
    const worstOf = row => row.worst_micros;
    for (const lane of LANES) {
      const before = totals().total;
      let during = null;
      stub.onCall = () => { during = totals().total; };
      stub.mode = 'typical';
      const r = await attempt(() => asks[lane](`probe-${lane}`, 4000, 128));
      stub.onCall = null;
      const after = totals().total;
      const rows = { builder: baseLedger.receipts(), quest: baseLedger.questReceipts(), effort: baseLedger.effortReceipts(), analysis: baseLedger.analysisReceipts() }[lane];
      const last = rows.find(row => row.idem.includes(`probe-${lane}`));
      check(`${lane}: while the stand-in is running, the day total already includes the full worst case`, r.ok && during === before + worstOf(last), `before=${before}, during=${during}, worst=${worstOf(last)}`);
      check(`${lane}: after settling the charge drops to actual usage`, last.state === 'settled' && last.charged_micros < worstOf(last) && after === before + last.charged_micros, `charged=${last.charged_micros} of worst ${worstOf(last)}`);
    }
    stub.mode = 'missing';
    for (const lane of LANES) {
      const before = totals().total;
      const calls = stub.count;
      const r = await attempt(() => asks[lane](`nousage-${lane}`, 4000, 128));
      const rows = { builder: baseLedger.receipts(), quest: baseLedger.questReceipts(), effort: baseLedger.effortReceipts(), analysis: baseLedger.analysisReceipts() }[lane];
      const last = rows.find(row => row.idem.includes(`nousage-${lane}`));
      check(`${lane}: a reply with no usage is not settled and the whole worst case stays counted`,
        stub.count === calls + 1 && last.state === 'dispatched' && last.charged_micros === last.worst_micros && totals().total === before + last.worst_micros,
        `state=${last.state}, held=${last.charged_micros}, caller saw ${r.ok ? `status ${r.value.status ?? 200}` : `error "${r.message}"`}`);
    }
    stub.mode = 'max';

    // ---------------------------------------------------------------------------------------------------------------
    section('2d. Per-person limits (each person is fresh; stand-in reports full usage so the dollars are real)');
    const msg = r => (r.ok ? 'admitted' : r.message);
    {
      // Quest: 3 calls a day.
      const results = [];
      for (let n = 0; n < 4; n += 1) results.push(await attempt(() => asks.quest('p-quest-calls', 200, 16)));
      log(`  Quest, 4 small calls by one person: ${results.map(msg).join(' | ')}`);
      check(`Quest allows ${QUEST_LIMITS.calls_per_person_day} calls per person per day and refuses the 4th`, results.slice(0, 3).every(r => r.ok) && /person daily call limit/.test(results[3].message ?? ''));
      const big = [await attempt(() => asks.quest('p-quest-dollars')), await attempt(() => asks.quest('p-quest-dollars'))];
      log(`  Quest, 2 max-size calls by one person: ${big.map(msg).join(' | ')}`);
      check(`Quest refuses a second call that would push one person past ${usd(QUEST_LIMITS.person_day_micros)} for the day`, big[0].ok && /person daily budget exceeded/.test(big[1].message ?? ''));
      check('a different person is not affected by the first person\'s limit', (await attempt(() => asks.quest('p-quest-other', 200, 16))).ok);
    }
    {
      const results = [];
      for (let n = 0; n < 11; n += 1) results.push(await attempt(() => asks.effort('p-effort-calls', 200, 16, `calls-item-${n}`)));
      log(`  Effort, 11 small calls by one person: ${results.slice(8).map(msg).join(' | ')}`);
      check(`Effort allows ${EFFORT_LIMITS.calls_per_person_day} on-demand calls per person per day and refuses the 11th`, results.slice(0, 10).every(r => r.ok) && /mention daily call limit/.test(results[10].message ?? ''));
      const big = [await attempt(() => asks.effort('p-effort-dollars')), await attempt(() => asks.effort('p-effort-dollars', BIG, 256, 'item-2'))];
      log(`  Effort, 2 max-size calls by one person: ${big.map(msg).join(' | ')}`);
      check(`Effort refuses a second call that would push one person past ${usd(EFFORT_LIMITS.person_day_micros)}`, big[0].ok && /person daily budget exceeded/.test(big[1].message ?? ''));
    }
    {
      const results = [];
      for (let n = 0; n < 4; n += 1) results.push(await attempt(() => analysis.ask('p-analysis-calls', `a-calls-${n}`, { p: `question ${n}` })));
      log(`  analysis, 4 small calls by one person: ${results.map(msg).join(' | ')}`);
      check(`analysis allows ${ANALYSIS_LIMITS.calls_per_person_day} calls per person per day and refuses the 4th`, results.slice(0, 3).every(r => r.ok) && /analysis daily call limit/.test(results[3].message ?? ''));
      const big = [await attempt(() => asks.analysis('p-analysis-dollars')), await attempt(() => analysis.ask('p-analysis-dollars', 'a-dollars-2', { p: bigText(BIG - 8 - 20) }))];
      log(`  analysis, 2 max-size calls by one person: ${big.map(msg).join(' | ')}`);
      check(`analysis refuses a second call that would push one person past ${usd(ANALYSIS_LIMITS.person_day_micros)}`, big[0].ok && /analysis daily budget exceeded/.test(big[1].message ?? ''));
    }

    // ---------------------------------------------------------------------------------------------------------------
    section('2a/2c. Flood: 400 simultaneous max-size calls, round robin over all four lanes, nothing settles until the end');
    const beforeFlood = totals(); const callsBeforeFlood = stub.count;
    let release; stub.gate = new Promise(resolve => { release = resolve; });
    const flood = [];
    for (let i = 0; i < 400; i += 1) {
      const lane = LANES[i % 4];
      flood.push(attempt(() => asks[lane](`flood-${i}`, BIG, lane === 'builder' ? 4096 : 256)).then(r => ({ lane, ...r })));
    }
    await Promise.resolve(); // every reserve ran synchronously; calls the ledger admitted are now parked at the stand-in gate
    const inFlight = stub.count; const midTotals = totals();
    log(`  stand-in has received ${inFlight} calls, all still waiting; day total already counted: ${midTotals.total} micro-dollars (${usd(midTotals.total)})`);
    check('while every admitted call is still in flight, the day total (worst-case holds only) is at or under the cap', midTotals.total <= DAY_CAP, `${midTotals.total} <= ${DAY_CAP}`);
    release(); stub.gate = null;
    const outcomes = await Promise.all(flood);
    const admitted = Object.fromEntries(LANES.map(lane => [lane, outcomes.filter(o => o.lane === lane && o.ok).length]));
    const reasons = {};
    for (const o of outcomes.filter(x => !x.ok)) { const key = `${o.lane}: ${o.message}`; reasons[key] = (reasons[key] || 0) + 1; }
    log(`  admitted per lane: ${JSON.stringify(admitted)}; refusals: ${JSON.stringify(reasons)}`);
    const afterFlood = totals();
    log(`  per-lane day subtotals: ${JSON.stringify(afterFlood.lanes)}; sum ${afterFlood.total}`);
    check('every lane contributed to the SAME day total (each lane has spend, and the lane subtotals add up to the total)',
      LANES.every(lane => afterFlood.lanes[lane] > beforeFlood.lanes[lane]) && Object.values(afterFlood.lanes).reduce((a, b) => a + b, 0) === afterFlood.total);
    check('the number of calls the stand-in received during the flood equals the number the gateway admitted (refused calls never reached it)',
      inFlight - callsBeforeFlood === Object.values(admitted).reduce((a, b) => a + b, 0) && stub.count === inFlight, `stand-in saw ${inFlight - callsBeforeFlood}, admitted ${Object.values(admitted).reduce((a, b) => a + b, 0)}`);
    check('day cap refusals came from the shared total in every lane (the builder was also stopped first by its own limit of 4 in flight)',
      LANES.every(lane => outcomes.some(o => o.lane === lane && /day cap exceeded/.test(o.message ?? ''))), Object.keys(reasons).join(' ; '));
    check('the builder lane was refused too (it can also be stopped first by its own concurrency limit of 4)', outcomes.some(o => o.lane === 'builder' && !o.ok));
    check('day total never exceeded the cap', afterFlood.total <= DAY_CAP, `${afterFlood.total} <= ${DAY_CAP}`);

    // Top up with small calls until nothing fits, then confirm every lane is refused and the stand-in hears nothing.
    let small = 0;
    for (; small < 1500;) { // bounded, so a broken cap fails the checks instead of looping for minutes
      const r = await attempt(() => asks.quest(`top-${small}`, 100, 16));
      if (!r.ok) break;
      small += 1;
    }
    const full = totals();
    log(`  after ${small} small top-up calls: day total ${full.total} of ${DAY_CAP}; headroom ${DAY_CAP - full.total} micro-dollars`);
    const heard = stub.count; const heardLanes = { ...stub.perLane };
    const refusal = {};
    for (const lane of LANES) refusal[lane] = await attempt(() => asks[lane](`late-${lane}`, 100, 16));
    for (const lane of LANES) log(`  ${lane} at the limit: ${msg(refusal[lane])}`);
    check('at the limit every lane refuses with the day cap', LANES.every(lane => !refusal[lane].ok && /day cap exceeded/.test(refusal[lane].message)));
    check('Quest, Effort and analysis refusals are typed "budget" (HTTP 429 with a plain sentence); the builder lane answers its agent with 402 via gateway/anthropic.js',
      ['quest', 'effort', 'analysis'].every(lane => refusal[lane].kind === 'budget'));
    check('the stand-in received NO call from any refused attempt', stub.count === heard && LANES.every(lane => stub.perLane[lane] === heardLanes[lane]), `stand-in total calls: ${stub.count}`);
    check('day total stays at or under 15,000,000 at the limit', full.total <= DAY_CAP, usd(full.total));
    const snapshotCap = totals();

    // ---------------------------------------------------------------------------------------------------------------
    section('2g. Database file replaced mid-day (a copy of the exhausted staging database is used, never the original)');
    {
      const scenario = join(dir, 'scenario.db');
      store.db.exec(`VACUUM INTO '${scenario}'`);
      const exhausted = track(new Store(scenario));
      const exhaustedLedger = new Ledger(exhausted, { clock, rate: rateWithSystemText(base, QUEST_SYSTEM) });
      const g1 = new QuestGateway(exhaustedLedger, async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }), { clock });
      const before = await attempt(() => g1.call('g-person', 'g1', { model: HAIKU.model, input: 'hello', max_output_tokens: 16 }));
      log(`  copy of the exhausted database, one call: ${msg(before)}`);
      check('the exhausted copy refuses (counter intact)', !before.ok && /day cap exceeded/.test(before.message));
      exhausted.close(); open.splice(open.indexOf(exhausted), 1);
      // The replacement: a seed template with the policy but no receipts. Also an empty database with no policy.
      cliAt(scenario, 'kill', 'set'); // the stop latch is a file beside the database path, not a row in it
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${scenario}${suffix}`, { force: true });
      copyFileSync(templatePath, scenario);
      const replaced = track(new Store(scenario));
      const replacedLedger = new Ledger(replaced, { clock, rate: rateWithSystemText(base, QUEST_SYSTEM) });
      log(`  after copying the seed template over it: day total ${new Ledger(replaced, { clock }).allMeteredReceipts().filter(row => row.day === day()).length} receipts today; kill latch still set: ${killed(replaced)}`);
      check('the stop latch (a file next to the database) survives the replacement', killed(replaced) === true);
      cliAt(scenario, 'kill', 'clear');
      const g2 = new QuestGateway(replacedLedger, async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }), { clock });
      const after = await attempt(() => g2.call('g-person', 'g2', { model: HAIKU.model, input: bigText(BIG), max_output_tokens: 256 }));
      const resetTotal = replacedLedger.allMeteredReceipts().filter(row => row.day === day()).reduce((n, row) => n + row.charged_micros, 0);
      log(`  after the replacement, a max-size call is: ${msg(after)}; day total now ${resetTotal}`);
      check('REPLACING THE DATABASE RESETS THE DAILY COUNTER: the day total is back near zero and a full-size call is admitted', after.ok && resetTotal < 100_000, `day total ${resetTotal} instead of ${snapshotCap.total}`);
      replaced.close(); open.splice(open.indexOf(replaced), 1);
      // An empty database (no policy) fails closed.
      const emptyPath = join(dir, 'empty.db');
      const empty = track(new Store(emptyPath));
      const emptyLedger = new Ledger(empty, { clock, rate: rateWithSystemText(base, QUEST_SYSTEM) });
      const g3 = new QuestGateway(emptyLedger, async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }), { clock });
      const emptyTry = await attempt(() => g3.call('g-person', 'g3', { model: HAIKU.model, input: 'hello', max_output_tokens: 16 }));
      log(`  a brand-new empty database (no policy row): ${msg(emptyTry)}`);
      check('a brand-new empty database refuses (gateway disabled until a policy is set): it fails closed', !emptyTry.ok && /gateway disabled/.test(emptyTry.message));
      empty.close(); open.splice(open.indexOf(empty), 1);
      log('  consequence: restoring a seed or backup puts the day spend back to whatever that file recorded, so the hosted demo');
      log('  reset script must carry the gateway_* tables over. 2g2 re-runs this same case against the real reset script.');
    }

    // ---------------------------------------------------------------------------------------------------------------
    section('2g2. Same case (g), but through the REAL hosted-demo reset script (deploy/hosted-demo/reset.js, injected clock)');
    {
      const scenario = join(dir, 'scenario-real-reset.db');
      store.db.exec(`VACUUM INTO '${scenario}'`);
      const peek = file => { const s = track(new Store(file)); const l = new Ledger(s, { clock }); const rows = l.allMeteredReceipts();
        const out = { receipts: rows.length, day: rows.filter(row => row.day === day()).reduce((n, row) => n + row.charged_micros, 0), lifetime: rows.reduce((n, row) => n + row.charged_micros, 0), policy: l.policy() };
        s.close(); open.splice(open.indexOf(s), 1); return out; };
      const beforeReset = peek(scenario);
      log(`  BEFORE the reset: ${beforeReset.receipts} receipts, day total ${beforeReset.day}, lifetime ${beforeReset.lifetime}, policy day_micros ${beforeReset.policy.day_micros} / global_micros ${beforeReset.policy.global_micros}`);
      // The real script, a forced mid-day reset (the worst case: the counter's own day is still running). It sets the kill latch.
      const result = runReset({ db: scenario, now: () => new Date(clock()), force: true });
      check('the real reset script ran (forced, mid-day) and set its kill latch', result.done === true && result.killed === true && killed(track(new Store(scenario))) === true);
      cliAt(scenario, 'kill', 'clear');
      const afterReset = peek(scenario);
      log(`  AFTER  the reset: ${afterReset.receipts} receipts, day total ${afterReset.day}, lifetime ${afterReset.lifetime}, policy day_micros ${afterReset.policy.day_micros} / global_micros ${afterReset.policy.global_micros}`);
      log('  (the receipt count can shrink: builder-lane receipts are rolled up into one sealed carry row per day; Quest, Effort and analysis receipts are copied as they are)');
      check('after the real reset the day total, lifetime total and policy are exactly what they were, and every remaining seal verifies', afterReset.day === beforeReset.day && afterReset.lifetime === beforeReset.lifetime && afterReset.receipts <= beforeReset.receipts && JSON.stringify(afterReset.policy) === JSON.stringify(beforeReset.policy), `before ${beforeReset.day}, after ${afterReset.day}`);
      const s2 = track(new Store(scenario));
      const g = new QuestGateway(new Ledger(s2, { clock, rate: rateWithSystemText(base, QUEST_SYSTEM) }), async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }), { clock });
      const again = await attempt(() => g.call('g-person', 'g4', { model: HAIKU.model, input: bigText(BIG), max_output_tokens: 256 }));
      log(`  a max-size call after the real reset: ${msg(again)}`);
      check('the exhausted day still refuses after the real reset: "day cap exceeded" (plain copy in 2g admitted it)', !again.ok && /day cap exceeded/.test(again.message));
      const demoRows = s2.db.prepare("SELECT count(*) n FROM actors WHERE kind='person'").get().n;
      check('the reset still replaced the non-ledger data with the seed roster (6 invented people)', demoRows === 6, `${demoRows} people`);
      s2.close(); open.splice(open.indexOf(s2), 1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    section('2e. The day is UTC and rolls over (server local zone is America/New_York)');
    now = Date.parse('2026-11-19T23:50:00.000Z');
    token = baseLedger.mint(run.id); // minted before midnight, valid until 00:05 UTC, so it also spans the boundary
    now = Date.parse('2026-11-19T23:59:59.999Z');
    log(`  clock = ${new Date(now).toISOString()} (server local time ${new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern)`);
    const lastMs = {};
    for (const lane of LANES) lastMs[lane] = await attempt(() => asks[lane](`edge-${lane}`, 100, 16));
    log(`  one millisecond before midnight UTC: ${LANES.map(lane => `${lane}: ${msg(lastMs[lane])}`).join(' | ')}`);
    check('one millisecond before 00:00 UTC every lane still refuses (still the old day, and the 8 PM local hour changed nothing)', LANES.every(lane => !lastMs[lane].ok && /day cap exceeded/.test(lastMs[lane].message)));
    now = Date.parse('2026-11-20T00:00:00.000Z');
    log(`  clock = ${new Date(now).toISOString()} (server local time ${new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern)`);
    const nextDay = {};
    for (const lane of LANES) nextDay[lane] = await attempt(() => asks[lane](`new-${lane}`, 100, 16));
    log(`  at 00:00:00.000 UTC: ${LANES.map(lane => `${lane}: ${msg(nextDay[lane])}`).join(' | ')}`);
    check('at 00:00:00.000 UTC the counter rolls over and every lane is admitted again', LANES.every(lane => nextDay[lane].ok));
    const d2 = totals();
    log(`  new day (${d2.day}) total ${d2.total}; yesterday's (${snapshotCap.day}) total still ${totals('2026-11-19').total}; lifetime ${d2.lifetime}`);
    check('yesterday\'s spend is kept under its own date and still counts toward the lifetime cap', totals('2026-11-19').total === snapshotCap.total && d2.lifetime >= snapshotCap.total && d2.total < 100_000);

    // Lifetime cap on a fresh day.
    section('2e2. The lifetime (global) cap still applies on a new day');
    setPolicy({ global_micros: d2.lifetime + 100 }); // 100 micro-dollars of headroom, less than any call's worst case
    const lifetimeTry = await attempt(() => asks.quest('life-1', 100, 16));
    log(`  lifetime cap set to just above what is spent; a normal call on the new day: ${msg(lifetimeTry)}`);
    check('a new day does not reopen a spent lifetime cap', !lifetimeTry.ok && /global cap exceeded/.test(lifetimeTry.message));
    setPolicy({});

    // ---------------------------------------------------------------------------------------------------------------
    section('2f. Policy switch (enabled: false) and the kill switch refuse spend immediately');
    const control = {};
    for (const lane of LANES) control[lane] = await attempt(() => asks[lane](`ctl-${lane}`, 100, 16));
    check('control: with the policy enabled and no kill latch every lane is admitted', LANES.every(lane => control[lane].ok));
    setPolicy({ enabled: false });
    const heardBefore = stub.count; const off = {};
    for (const lane of LANES) off[lane] = await attempt(() => asks[lane](`off-${lane}`, 100, 16));
    log(`  policy enabled:false -> ${LANES.map(lane => `${lane}: ${msg(off[lane])}`).join(' | ')}`);
    check('enabled:false refuses every lane at once, with no call to the stand-in', LANES.every(lane => !off[lane].ok && /gateway disabled/.test(off[lane].message)) && stub.count === heardBefore);
    setPolicy({});
    const killResult = cli('kill', 'set');
    check('`kill set` reports stopped', /^stopped$/m.test(killResult.out));
    const heardKill = stub.count; const dead = {};
    for (const lane of LANES) dead[lane] = await attempt(() => asks[lane](`kill-${lane}`, 100, 16));
    log(`  after kill set -> ${LANES.map(lane => `${lane}: ${msg(dead[lane])}`).join(' | ')}`);
    check('after `kill set` the builder, Quest and Effort lanes refuse ("stopped run") with no stand-in call', ['builder', 'quest', 'effort'].every(lane => !dead[lane].ok && /stopped run/.test(dead[lane].message)));
    check('after `kill set` the analysis lane ALSO refuses', !dead.analysis.ok, dead.analysis.ok ? 'BUG: analysis lane ignores the kill switch' : msg(dead.analysis));
    check('the stand-in received no call after the kill switch', stub.count === heardKill + (dead.analysis.ok ? 1 : 0), `stand-in calls since kill: ${stub.count - heardKill}`);
    cli('kill', 'clear');

    // ---------------------------------------------------------------------------------------------------------------
    section('4. Worst-case and typical calls per day at $15 (from the price table above and this policy)');
    const priceRow = (label, rate, inBytes, outTokens, typicalIn, typicalOut, note) => {
      const worst = Math.ceil((((inBytes + rate.framing_tokens) * rate.input_micros_per_million) + outTokens * rate.output_micros_per_million) / 1_000_000);
      const typical = Math.ceil((typicalIn * rate.input_micros_per_million + typicalOut * rate.output_micros_per_million) / 1_000_000);
      const line = { label, worst, callsAtWorst: Math.floor(DAY_CAP / worst), typical, callsAtTypical: Math.floor(DAY_CAP / typical), note };
      log(`  ${label.padEnd(24)} worst-case hold ${String(worst).padStart(6)} micros (${usd(worst)}) -> ${String(line.callsAtWorst).padStart(4)} calls fill $15 | typical ${String(typical).padStart(6)} micros -> ${String(line.callsAtTypical).padStart(5)} calls | ${note}`);
      return line;
    };
    const quest2 = questLedger.rate; const effort2 = effortLedger.rate;
    const table = [
      priceRow('Quest draft', quest2, PROOF_POLICY.input_bytes, QUEST_LIMITS.output_tokens, 2500, 250, `3 calls/person/day, ${usd(QUEST_LIMITS.person_day_micros)}/person`),
      priceRow('Effort reply', effort2, PROOF_POLICY.input_bytes, EFFORT_LIMITS.output_tokens, 2000, 100, `10 calls/person/day, ${usd(EFFORT_LIMITS.person_day_micros)}/person (worker asks for 128 out)`),
      priceRow('Effort SPEC draft', effort2, PROOF_POLICY.input_bytes, 1024, 3000, 600, 'output cap 1,024'),
      priceRow('Analysis answer', base, PROOF_POLICY.input_bytes, ANALYSIS_LIMITS.output_tokens, 4000, 2200, `3 calls/person/day, ${usd(ANALYSIS_LIMITS.person_day_micros)}/person; docs/MODEL_EVAL.md: about 1.5 cents`),
      priceRow('Builder model call', base, PROOF_POLICY.input_bytes, PROOF_POLICY.output_tokens, 20000, 1500, 'a build is many calls; docs/BUILDER_EVAL.md: about 5 to 6.5 cents per build'),
    ];
    check('every lane has a finite worst-case calls-per-day figure at $15', table.every(row => row.callsAtWorst > 0 && row.callsAtWorst < 1000));
    log(`  people needed to spend the whole $15 through one lane at the per-person limits (worst-case): Quest ${Math.ceil(DAY_CAP / (QUEST_LIMITS.calls_per_person_day * table[0].worst))}, analysis ${Math.ceil(DAY_CAP / (ANALYSIS_LIMITS.calls_per_person_day * table[3].worst))} (per-person limits shape who spends it, the shared day cap is what bounds the total)`);

    const failed = checks.filter(c => !c.ok);
    log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map(c => c.name).join(' | ')}` : ''}`);
    return { checks, failed, table, dir: keep ? dir : null };
  } finally {
    for (const store of open) { try { store.close(); } catch { /* already closed */ } }
    if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz;
    if (!keep && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await proveDailyCap({ keep: process.argv.includes('--keep') });
  if (result.dir) console.log(`kept: ${result.dir}`);
  process.exitCode = result.failed.length ? 1 : 0;
}
