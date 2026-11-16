// Browser proof of the submitted outcome form and immutable decision record.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.NODE_TEST_CONTEXT) await main();

async function main() {
  const require = createRequire(import.meta.url);
  const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
  const root = new URL('../..', import.meta.url).pathname;
  const db = join(mkdtempSync(join(tmpdir(), 'sss-decision-')), 'sss.db');
  const env = { ...process.env, SSS_DB: db };
  const port = 24000 + Math.floor(Math.random() * 1000), origin = `http://127.0.0.1:${port}`;
  const cli = args => new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env });
    child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    child.on('close', code => code ? reject(Error(err || out)) : resolve(out.trim()));
  });
  const init = await cli(['init', '--id', 'leader']);
  let leaderPassword = init.match(/one-time password: (\S+)/)[1];
  const invite = await cli(['invite', 'create', '--role', 'member']);
  const server = spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies'], { cwd: root, env });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/signin`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const leader = await browser.newPage(), op = await browser.newPage();
    await leader.goto(`${origin}/signin`); await leader.locator('[name=id]').fill('leader'); await leader.locator('[name=password]').fill(leaderPassword);
    await leader.getByRole('button', { name: 'Sign in' }).click();
    await leader.locator('[name=current]').fill(leaderPassword); leaderPassword = 'leader-chosen-password-9x';
    await leader.locator('form[data-password] [name=password]').fill(leaderPassword); await leader.getByRole('button', { name: 'Change password' }).click();
    await leader.getByRole('link', { name: 'Post a problem' }).waitFor();
    await op.goto(`${origin}/redeem`); await op.locator('[name=invite]').fill(invite); await op.locator('[name=id]').fill('op');
    await op.locator('[name=password]').fill('op-long-password-35x'); await op.getByRole('button', { name: 'Join' }).click();
    await op.getByRole('link', { name: 'Post a problem' }).waitFor();
    await op.goto(`${origin}/items/new`); await op.locator('[name=original]').fill('The next agent cannot find the caller note.');
    await op.getByRole('button', { name: 'Post SEE' }).click(); await op.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const itemUrl = op.url();
    await op.locator('form[data-event=specced] [name=must]').fill('Keep the caller note visible.');
    await op.locator('form[data-event=specced] [name=how_we_know]').fill('The next agent can find the note.');
    await op.getByRole('button', { name: 'SPEC IT!' }).click(); await op.getByRole('link', { name: 'Open the spec' }).waitFor();
    await op.goto(`${itemUrl}/spec`); await op.getByRole('button', { name: 'SEND IT!' }).click();
    await op.waitForFunction(() => !document.querySelector('form[data-send]'));
    await leader.goto(itemUrl); await leader.getByRole('heading', { name: 'Decision packet' }).waitFor();
    const form = leader.locator('form[data-decision]');
    await form.locator('[name=disposition]').selectOption('defer'); await form.locator('[name=reason_code]').fill('dependency_outstanding');
    await form.locator('[name=reason]').fill('Wait for the service owner to confirm readiness.');
    await form.locator('[name=owner]').fill('service-owner'); await form.locator('[name=review_by]').fill('2026-12-01');
    await form.getByRole('button', { name: 'Record decision' }).click();
    await leader.getByRole('heading', { name: 'Decision record' }).waitFor();
    await leader.getByText('service-owner', { exact: false }).waitFor();
    assert.match(await leader.locator('main').innerText(), /Defer/);
    assert.match(await leader.locator('main').innerText(), /2026-12-01/);
    process.stdout.write('PASS decision outcome browser journey\n');
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
}
