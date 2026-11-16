// Automated accessibility audit with axe-core in real Chrome. Synthetic data only.
//   AXE_PATH=/path/to/axe.min.js NODE_PATH=<dir with playwright> node scripts/a11y-audit.mjs
// Reports WCAG 2 A and AA violations per page and viewport. Automated checks find roughly a third of real problems,
// so a clean result here is a floor, not a pass of a full accessibility review.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { runReanalysis } from '../reanalysis/run.js';
const require = createRequire(import.meta.url);
const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
const axe = readFileSync(process.env.AXE_PATH, 'utf8');
const root = new URL('..', import.meta.url).pathname, db = join(mkdtempSync(join(tmpdir(), 'sss-a11y-')), 'sss.db'), env = { ...process.env, SSS_DB: db };
const cli = args => new Promise((resolve, reject) => { let out = '', err = ''; const c = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env }); c.stdout.on('data', b => out += b); c.stderr.on('data', b => err += b); c.on('close', code => code ? reject(Error(err || out)) : resolve(out.trim())); });
await cli(['init', '--id', 'admin']);
const port = 25000 + Math.floor(Math.random() * 1500), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies'], { cwd: root, env, stdio: 'ignore' });
const results = []; let browser;
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${origin}/signin`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const invite = await cli(['invite', 'create', '--role', 'member']);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
  const audit = async (name, url) => {
    for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      await page.setViewportSize(size); await page.goto(url); await page.waitForLoadState('networkidle').catch(() => {});
      await page.evaluate(axe); const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
      for (const v of r.violations) results.push({ page: name, viewport: label, rule: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0]?.html.slice(0, 120) });
    }
  };
  await audit('sign in', `${origin}/signin`); await audit('redeem', `${origin}/redeem`);
  await page.goto(`${origin}/redeem`); await page.locator('[name=invite]').fill(invite); await page.locator('[name=id]').fill('dana'); await page.locator('[name=password]').fill('a-long-a11y-passphrase-9x');
  await page.getByRole('button', { name: 'Join' }).click(); await page.getByRole('link', { name: 'Post a problem' }).waitFor();
  await page.goto(`${origin}/items/new`); await page.locator('[name=original]').fill('The handoff loses the caller note.'); await page.getByRole('button', { name: 'Post SEE' }).click(); await page.waitForURL(/\/items\/(?!new$)[^/]+$/);
  const item = new URL(page.url()).pathname.split('/').at(-1);
  await audit('feed', `${origin}/`); await audit('new item', `${origin}/items/new`); await audit('item (SEE)', `${origin}/items/${item}`);
  await audit('knowledge', `${origin}/knowledge`); await audit('search', `${origin}/search?q=handoff`); await audit('intelligence', `${origin}/intelligence`); await audit('mentoring', `${origin}/mentoring`);
  // A frozen case with a decision and an update, so those pages are covered too.
  const store = new Store(db); let n = 0; const add = (it, e) => store.append(it, { ...e, at: '2026-11-10T12:00:00.000Z' }, { idem: `a-${++n}` });
  const bind = it => ({ post_id: store.read(it).context.activePost?.id, post_version: store.read(it).context.activePost?.version });
  add(item, { type: 'specced', actor: 'dana', see_hash: store.read(item).context.seeHash, must: ['Keep the note'], how_we_know: ['It appears'], out_of_scope: [], assumptions: ['The handoff needs a new integration to carry the caller note.'], open_questions: [], ...bind(item) });
  const spec = store.read(item).context.specHash, packet = store.putArtifact(item, JSON.stringify({ specHash: spec }));
  add(item, { type: 'sent', actor: 'dana', spec_hash: spec, packet_hash: packet, ...bind(item) });
  add(item, { type: 'decided', actor: 'admin', disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration this quarter.', metadata: {}, spec_hash: spec, packet_hash: packet, ...bind(item) });
  add('other', { type: 'posted', actor: 'dana', original: 'Night shift export problem.', rules: 3 });
  store.close();
  await audit('spec', `${origin}/items/${item}/spec`); await audit('item (decided)', `${origin}/items/${item}`);
  const post = new Store(db).db.prepare("SELECT post_id FROM stage_posts WHERE item=? AND kind='decision'").get(item);
  if (post) { const w = new Store(db); (await import('../core/closeout.js')).runCloseoutJobs(w, {}); w.close(); await audit('closing report', `${origin}/items/${item}/closeout/${encodeURIComponent(post.post_id)}`); }
} finally { await browser?.close(); server.kill(); }
const byRule = new Map(); for (const r of results) { const k = `${r.rule} (${r.impact})`; byRule.set(k, [...(byRule.get(k) || []), r]); }
console.log(`${results.length} violation records across ${new Set(results.map(r => `${r.page}/${r.viewport}`)).size} page views`);
for (const [rule, rows] of [...byRule].sort((a, b) => b[1].length - a[1].length)) console.log(`\n${rule}: ${rows.length}x  pages: ${[...new Set(rows.map(r => r.page))].join(', ')}\n   ${rows[0].help}\n   e.g. ${rows[0].sample}`);
if (!results.length) console.log('No WCAG 2.1 A/AA violations found by axe-core on the audited pages.');
process.exitCode = results.length ? 1 : 0;
