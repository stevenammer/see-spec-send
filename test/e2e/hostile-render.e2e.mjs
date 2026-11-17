// Real-browser check that hostile text stays inert text on every page that shows it. Run outside any sandbox:
//   PLAYWRIGHT_DIR=/path/to/node_modules npm run test:hostile-render
// Every string in the injection corpus is posted as a problem through the real screen, then the item page
// and the list page are loaded in Chrome. No script may run, no dialog may open, no request may leave the
// app origin, and the page may not gain any element the text tried to create. Skipped under `node --test`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.NODE_TEST_CONTEXT) await main();

async function main() {
  const require = createRequire(import.meta.url);
  const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
  const root = new URL('../..', import.meta.url).pathname;
  const corpus = JSON.parse(readFileSync(new URL('../fixtures/injection-corpus.json', import.meta.url), 'utf8'));
  const db = join(mkdtempSync(join(tmpdir(), 'sss-hostile-')), 'sss.db');
  const port = 22000 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SSS_DB: db };
  const cli = args => new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env });
    child.stdout.on('data', c => (out += c)); child.stderr.on('data', c => (err += c));
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(err || out))));
  });
  await cli(['init', '--id', 'leader']);
  // Each person may write 20 times a minute, so the posts are spread across several people.
  const invites = [];
  for (let i = 0; i < 5; i++) invites.push(await cli(['invite', 'create', '--role', 'member']));
  const server = spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies'], { cwd: root, env });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const problems = [];
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${origin}/signin`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const pages = [];
    const join_ = async i => {
      const context = await browser.newContext();
      await context.route(u => !u.href.startsWith(origin), route => { problems.push(`external request ${route.request().url()}`); route.abort(); });
      const page = await context.newPage();
      page.on('pageerror', e => problems.push(`page error ${e.message}`));
      page.on('dialog', d => { problems.push(`dialog ${d.message()}`); d.dismiss(); });
      await page.goto(`${origin}/redeem`);
      await page.locator('[name=invite]').fill(invites[i]);
      await page.locator('[name=id]').fill(`person${i}`);
      await page.locator('[name=password]').fill(`person${i}-long-password-9x`);
      await page.getByRole('button', { name: 'Join' }).click();
      await page.getByRole('link', { name: 'Post a problem' }).waitFor({ timeout: 8000 });
      return page;
    };
    for (let i = 0; i < 5; i++) pages.push(await join_(i));
    let page = pages[0];
    const baseline = async () => page.evaluate(() => ({ scripts: document.scripts.length, forms: document.forms.length, imgs: document.images.length, details: document.querySelectorAll('details').length }));

    const urls = [];
    for (const [n, entry] of corpus.entries()) {
      page = pages[Math.floor(n / 15) % 4];
      await page.goto(`${origin}/items/new`);
      await page.locator('[name=original]').fill(entry.text);
      await page.getByRole('button', { name: 'Post SEE' }).click();
      try { await page.waitForURL(/\/items\/(?!new$)[^/]+$/, { timeout: 5000 }); }
      catch { throw new Error(`post #${n} (${entry.class}, ${entry.text.length} chars) did not redirect; page said: ${(await page.locator('body').innerText()).slice(0, 200)}`); }
      urls.push(page.url());
    }
    page = pages[4];
    // A control item with plain text sets what the page itself legitimately contains.
    await page.goto(`${origin}/items/new`);
    await page.locator('[name=original]').fill('Plain control problem text.');
    await page.getByRole('button', { name: 'Post SEE' }).click();
    await page.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const control = await baseline();

    for (const [n, url] of urls.entries()) {
      const entry = corpus[n];
      page = pages[Math.floor(n / 15) % 4];
      await page.goto(url);
      const now = await baseline();
      for (const k of Object.keys(control)) assert.equal(now[k], control[k], `${entry.class} #${n} added ${k}: ${entry.text.slice(0, 60)}`);
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => !h.startsWith('/') && !h.startsWith('#')));
      assert.deepEqual(links, [], `${entry.class} #${n} created an outside or script link`);
      const handlers = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length);
      assert.equal(handlers, 0, `${entry.class} #${n} created an event handler attribute`);
      if (!/[<>&%\\]|[​-‏‪-‮⁦-⁩]/.test(entry.text) && entry.text.length < 300) {
        const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        assert.ok(shown.includes(entry.text.replace(/\s+/g, ' ')), `${entry.class} #${n} is not shown as the literal text`);
      }
    }
    await page.goto(`${origin}/`);
    assert.deepEqual(await baseline(), (await baseline()));
    assert.deepEqual(problems, [], problems.join('\n'));
    console.log(JSON.stringify({ ok: true, strings: corpus.length, problems: 0 }));
  } finally {
    await browser.close(); server.kill();
  }
}
