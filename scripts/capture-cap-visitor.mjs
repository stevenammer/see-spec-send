// What a visitor sees when the day cap is reached, through the real HTTP server and (optionally) real headless Chrome.
// ZERO spend, no outside network: the model provider is a stand-in on 127.0.0.1 that counts the requests it receives
// (it must receive none once the cap is reached). Throwaway database in a temp directory.
//
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node scripts/capture-cap-visitor.mjs --shots /abs/dir
//   (without --shots or Playwright the browser step is skipped and only the HTTP answers are printed)
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { saveProviders } from '../provider/config.js';
import { Ledger, priceRate, rateWithSystemText } from '../gateway/ledger.js';
import { QuestGateway } from '../gateway/quest.js';
import { QUEST_SYSTEM } from '../provider/vision-quest.js';
import { completedQuest } from '../test/helpers/quest-fixture.mjs';
import { errorFor } from '../gateway/anthropic.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'cli.js');
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const HAIKU = { model: 'anthropic.claude-haiku-4-5-20251001-v1:0', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 5_000_000 };
const dir = mkdtempSync(join(tmpdir(), 'sss-cap-visitor-'));
const db = join(dir, 'staging.db');
const env = { ...process.env, SSS_DB: db, SSS_PROVIDERS_FILE: join(dir, 'providers.json'), SSS_TEST_KEY: 'synthetic', NODE_NO_WARNINGS: '1' };
const say = line => console.log(line);
let child; let upstream; let browser;
try {
  // Loopback stand-in for the model. Counts requests; replies with usage if it is ever asked.
  let upstreamCalls = 0;
  upstream = createServer(async (req, res) => {
    upstreamCalls += 1; for await (const chunk of req) void chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'stand-in reply' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  saveProviders({ providers: [{ name: 'mock', kind: 'openai', model: HAIKU.model, enabled: true,
    url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`, hosts: ['127.0.0.1'], allowPrivate: true,
    apiKeyEnv: 'SSS_TEST_KEY', price: { inputMicrosPerMillion: HAIKU.inputMicrosPerMillion, outputMicrosPerMillion: HAIKU.outputMicrosPerMillion } }], defaults: { default: 'mock' } }, env);
  const store = new Store(db);
  await new Auth(store).createUser('maker', 'synthetic-long-passphrase-7', false);
  store.close();
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  cli('gateway', 'fixture-enable');
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ enabled: true, global_micros: 100_000_000, day_micros: 15_000_000, concurrency: 4,
    input_bytes: 65536, output_tokens: 4096, response_bytes: 65536, timeout_ms: 30000 }));
  say(`$ node cli.js gateway policy set --file policy.json -> ${cli('gateway', 'policy', 'set', '--file', join(dir, 'policy.json')).stdout.trim()}`);

  // Use up the whole $15 day (stand-in usage, Quest lane, many people) BEFORE the server starts.
  {
    const s = new Store(db);
    const ledger = new Ledger(s, { rate: rateWithSystemText(priceRate({ ...HAIKU, framingTokens: 8 }), QUEST_SYSTEM) });
    const gateway = new QuestGateway(ledger, async input => ({ output: 'x', usage: { input_tokens: Buffer.byteLength(input.input) + Buffer.byteLength(QUEST_SYSTEM), output_tokens: input.max_output_tokens } }));
    let n = 0;
    for (;;) { try { await gateway.call(`filler-${n}`, `fill-${n}`, { model: HAIKU.model, input: 'x'.repeat(65536), max_output_tokens: 256 }); n += 1; } catch { break; } }
    for (;;) { try { await gateway.call(`filler-s${n}`, `fills-${n}`, { model: HAIKU.model, input: 'x'.repeat(50), max_output_tokens: 8 }); n += 1; } catch { break; } }
    say(`day filled with ${n} stand-in calls; day cap $15.00`);
    s.close();
  }
  say(`$ node cli.js gateway status -> ${cli('gateway', 'status').stdout.trim().slice(0, 160)}...`);
  say(`stand-in requests received by the loopback provider so far: ${upstreamCalls}`);

  // Real server, with the Quest, Effort and analysis lanes switched on.
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let log = '';
  child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies',
    '--enable-quest-model', '--quest-provider', 'mock', '--enable-effort', '--effort-provider', 'mock', '--analysis-provider', 'mock'], { env });
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100 && !log.includes('Serving '); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
  if (!log.includes('Serving ')) throw Error(`server did not start: ${log}`);
  const post = (path, payload, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(payload) });
  const login = await post('/api/login', { id: 'maker', password: 'synthetic-long-passphrase-7' });
  const csrf = (await login.json()).csrf;
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'x-csrf-token': csrf };

  say('\n--- Quest model draft: POST /api/quest/model/draft ---');
  const draft = await post('/api/quest/model/draft', { quest: completedQuest(), max_output_tokens: 256 }, { ...headers, 'idempotency-key': 'visitor-1' });
  say(`HTTP ${draft.status} ${await draft.text()}`);

  const posted = await post('/api/items', { original: 'The refund queue loses transfer notes between shifts.' }, { ...headers, 'idempotency-key': 'item-1' });
  const item = (await posted.json()).id;
  say(`\n(posted a SEE as the visitor: HTTP ${posted.status}, item ${String(item).slice(0, 12)}...; this queues the automatic Effort reply)`);

  say('\n--- Analysis lane: POST /api/intelligence/run ("Run with Effort") ---');
  await new Promise(resolve => setTimeout(resolve, 2000)); // the activity window must end in the past, after the post
  const to = new Date(Date.now() - 500).toISOString();
  const request = { question: 'Where do refund problems keep getting stuck?', objectives: ['Find where notes get lost'], constraints: ['Customers still get a receipt'], items: [item], from: '2026-01-01T00:00:00.000Z', to };
  const run = await post('/api/intelligence/run', request, headers);
  const runText = await run.text();
  say(`HTTP ${run.status} ${runText.slice(0, 700)}${runText.length > 700 ? ' ...' : ''}`);

  say('\n--- Effort lane: the item page after the automatic reply was attempted ---');
  let page = '';
  for (let i = 0; i < 40; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    page = await (await fetch(`${origin}/items/${item}`, { headers: { cookie } })).text();
    if (/Effort \(the AI\)[^<]*(blocked|unavailable|replied|thinking)/.test(page)) break;
  }
  for (const line of page.match(/<p>Effort \(the AI\)[^<]*<\/p>/g) || []) say(line.replace(/<[^>]+>/g, ''));
  const allowance = /<details><summary>AI usage and limits[\s\S]*?<\/details>/.exec(page)?.[0]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  say(`AI usage panel: ${allowance}`);

  say('\n--- Builder agent: what its HTTP gateway answers (library mapping used by /v1/messages) ---');
  for (const reason of ['day cap exceeded', 'global cap exceeded']) { const { status, body } = errorFor(Error(reason)); say(`${reason}: HTTP ${status} ${JSON.stringify(body)}`); }

  say(`\nstand-in requests received by the loopback provider (should be 0): ${upstreamCalls}`);

  if (shots) {
    mkdirSync(shots, { recursive: true });
    const require = createRequire(import.meta.url);
    const { chromium } = process.env.PLAYWRIGHT_DIR ? require(process.env.PLAYWRIGHT_DIR) : require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const [name, ...rest] = cookie.split('='); await context.addCookies([{ name, value: rest.join('='), url: origin }]);
    const tab = await context.newPage();
    await tab.goto(`${origin}/items/${item}`);
    await tab.locator('details', { hasText: 'AI usage and limits' }).evaluate(el => { el.open = true; });
    await tab.screenshot({ path: join(shots, 'effort-item-page.png'), fullPage: true });
    say(`screenshot: ${join(shots, 'effort-item-page.png')}`);
    await tab.goto(`${origin}/intelligence`);
    await tab.fill('[name=question]', request.question); await tab.fill('[name=objectives]', request.objectives[0]);
    await tab.fill('[name=constraints]', request.constraints[0]); await tab.fill('[name=items]', item);
    for (const [field, value] of [['from', '2026-01-01T00:00:00'], ['to', to.slice(0, 19)]]) await tab.locator(`[name=${field}]`).evaluate((el, v) => { el.value = v; }, value);
    await tab.click('[data-analysis-run]');
    await tab.waitForSelector('[data-analysis-answer]:not([hidden]), [role=alert]', { timeout: 15000 });
    await tab.screenshot({ path: join(shots, 'analysis-intelligence-page.png'), fullPage: true });
    say(`screenshot: ${join(shots, 'analysis-intelligence-page.png')}`);
    say(`what the Investigate page shows: ${(await tab.locator('[data-analysis-answer]:not([hidden]), [role=alert]').first().innerText()).replace(/\n+/g, ' ')}`);
  }
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
