// Real-browser walkthrough of the whole manual path. Run outside any sandbox:
//   PLAYWRIGHT_DIR=/path/to/node_modules npm run test:e2e
// It starts the real server, signs four different people in through the real screens,
// and drives one item to Helps and another to Shelved. It is skipped under `node --test`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.NODE_TEST_CONTEXT) await main();

async function main() {
  const require = createRequire(import.meta.url);
  const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
  const root = new URL('../..', import.meta.url).pathname;
  const shots = join(root, 'docs/screens');
  mkdirSync(shots, { recursive: true });
  const db = join(mkdtempSync(join(tmpdir(), 'sss-e2e-')), 'sss.db');
  const port = 18000 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SSS_DB: db };

  const cli = args =>
    new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      const child = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env });
      child.stdout.on('data', chunk => (out += chunk));
      // Node prints an experimental SQLite warning on stderr; it must not leak into the output.
      child.stderr.on('data', chunk => (err += chunk));
      child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(err || out))));
    });

  const init = await cli(['init', '--id', 'leader']);
  let leaderPassword = init.match(/one-time password: (\S+)/)[1];
  await cli(['gateway', 'fixture-enable']);
  const invites = {};
  for (const name of ['maya', 'ben', 'cleo'])
    invites[name] = await cli(['invite', 'create', '--role', 'member']);

  const server = spawn(
    process.execPath,
    ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies', '--enable-effort', '--fixture'],
    { cwd: root, env },
  );
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const problems = [];
  const people = {};

  async function open(name) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push(`${name} page error: ${error.message}`));
    page.on('dialog', dialog => {
      problems.push(`${name} dialog: ${dialog.message()}`);
      dialog.dismiss();
    });
    page.on('framenavigated', () => {});
    page.on('request', request => {
      if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) {
        problems.push(`${name} external request: ${request.url()}`);
      }
    });
    people[name] = page;
    return page;
  }

  async function waitForServer() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if ((await fetch(`${origin}/signin`)).ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('server did not start');
  }

  async function join_(name) {
    const page = await open(name);
    await page.goto(`${origin}/redeem`);
    await page.locator('[name=invite]').fill(invites[name]);
    await page.locator('[name=id]').fill(name);
    await page.locator('[name=password]').fill(`${name}-long-password-9x`);
    await page.getByRole('button', { name: 'Join' }).click();
    try {
      await page.getByRole('link', { name: 'Post a problem' }).waitFor({ timeout: 8000 });
    } catch (error) {
      throw new Error(
        `${name} could not join. URL ${page.url()}. Page said: ${(await page.locator('body').innerText()).slice(0, 200)}. Problems: ${problems.join(' | ')}`,
        { cause: error },
      );
    }
  }

  async function postProblem(page, text) {
    await page.goto(`${origin}/items/new`);
    await page.locator('[name=original]').fill(text);
    await page.getByRole('button', { name: 'Post SEE' }).click();
    await page.waitForURL(/\/items\/(?!new$)[^/]+$/);
    return page.url();
  }

  const stage = async (page, word) => {
    try {
      await page.locator('.stage', { hasText: word }).waitFor({ timeout: 8000 });
    } catch (error) {
      const text = (await page.locator('body').innerText()).slice(0, 300);
      throw new Error(
        `expected stage ${word} at ${page.url()}. Page said: ${text}. Problems: ${problems.join(' | ')}`,
        { cause: error },
      );
    }
  };
  const shot = async (page, name, width = 1280) => {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  };

  try {
    await waitForServer();

    // The leader signs in through the real screen.
    const leader = await open('leader');
    await leader.goto(`${origin}/signin`);
    await leader.locator('[name=id]').fill('leader');
    await leader.locator('[name=password]').fill(leaderPassword);
    await leader.getByRole('button', { name: 'Sign in' }).click();
    // The first password is temporary: the screen asks for a real one before anything else.
    await leader.locator('[name=current]').fill(leaderPassword);
    leaderPassword = 'leader-chosen-password-9x';
    await leader.locator('form[data-password] [name=password]').fill(leaderPassword);
    await leader.getByRole('button', { name: 'Change password' }).click();
    await leader.getByRole('link', { name: 'Post a problem' }).waitFor();

    for (const name of ['maya', 'ben', 'cleo']) await join_(name);

    // SEE: Maya posts a problem she saw.
    const maya = people.maya;
    const itemUrl = await postProblem(maya, 'Every quote needs the same three numbers copied by hand.');
    await maya.getByRole('heading', { name: 'Original' }).waitFor();
    await shot(maya, 'item-checked');

    // The leader sees the same item but is not the steward, so there is no spec form.
    await leader.goto(itemUrl);
    assert.equal(await leader.locator('form[data-event=specced]').count(), 0);

    // SPEC IT!: only the steward writes it, then sends it for a decision.
    await maya
      .locator('form[data-event=specced] [name=must]')
      .fill('Copy the three numbers into the quote.\nShow the total.');
    await maya.locator('form[data-event=specced] [name=how_we_know]').fill('Reps stop copying by hand.');
    await maya.getByRole('button', { name: 'SPEC IT!' }).click();
    await maya.getByRole('link', { name: 'Open the spec' }).waitFor();
    await maya.goto(`${itemUrl}/spec`);
    await maya.getByRole('button', { name: 'SEND IT!' }).click();
    await maya.waitForFunction(() => !document.querySelector('form[data-send]'));
    await maya.goto(itemUrl);
    await stage(maya, 'Decide');
    assert.equal(await maya.locator('form[data-approve]').count(), 0, 'steward cannot approve');

    // Decide: a leader who is not the steward reads the packet and approves with a reason,
    // a cap, a quorum and a step-up.
    await leader.goto(itemUrl);
    await leader.getByRole('heading', { name: 'Decision packet' }).waitFor();
    await shot(leader, 'item-decide');
    await leader
      .locator('form[data-approve] [name=reason]')
      .fill('Small enough to try and the spec is clear.');
    await leader.locator('form[data-approve] [name=cap_usd]').fill('2');
    await leader.locator('form[data-approve] [name=quorum]').fill('2');
    await leader.locator('form[data-approve] [name=password]').fill(leaderPassword);
    await leader.locator('form[data-approve] button').click();
    await stage(leader, 'Send');

    // Send: the steward delivers a playable try.
    await maya.goto(itemUrl);
    const html =
      '<!doctype html><title>Try</title><button id="b">Total it</button>' +
      '<script>document.getElementById("b").onclick=()=>{document.body.append(" 42")}</script>';
    await maya.locator('form[data-artifact] [name=html]').fill(html);
    await maya.locator('form[data-artifact] button').click();
    await maya.locator('iframe[title="Playable try"]').waitFor();
    assert.equal(await maya.locator('form[data-event=helped]').count(), 0, 'steward cannot vote');

    // The approver cannot vote either.
    await leader.goto(itemUrl);
    assert.equal(
      await leader.locator('form[data-event=helped]').count(),
      0,
      'approver cannot vote',
    );

    // Two other people try it and say it helps. One person counts once.
    const ben = people.ben;
    await ben.goto(itemUrl);
    const frame = ben.frameLocator('iframe[title="Playable try"]');
    await frame.getByRole('button', { name: 'Total it' }).click();
    await frame.locator('body').getByText('42').waitFor();
    await shot(ben, 'item-trying');
    // The try runs in an opaque origin: no cookie and no way into the app page.
    const reach = await frame.locator('body').evaluate(() => {
      let parentAccess = 'blocked';
      try {
        void window.parent.document.title;
        parentAccess = 'reached';
      } catch {}
      let cookie = 'readable';
      try {
        void document.cookie;
      } catch {
        cookie = 'blocked';
      }
      return { parentAccess, cookie };
    });
    assert.deepEqual(reach, { parentAccess: 'blocked', cookie: 'blocked' });
    await ben.locator('form[data-event=helped] button').click();
    await ben.getByText('1 of 2 people have said it helps').waitFor();
    await ben.reload();
    await ben
      .locator('form[data-event=helped] button')
      .click()
      .catch(() => {});
    await ben.getByText('1 of 2 people have said it helps').waitFor();

    const cleo = people.cleo;
    await cleo.goto(itemUrl);
    await cleo.locator('form[data-event=helped] button').click();
    await cleo.locator('.helps').waitFor();
    await shot(cleo, 'item-helps');
    assert.equal(
      await cleo.locator('button', { hasText: /done/i }).count(),
      0,
      'there is no done button',
    );

    // The feed shows plain progress, never names.
    await leader.goto(origin);
    const feed = await leader.locator('main').innerText();
    assert.match(feed, /Helps/);
    assert.doesNotMatch(feed, /maya|ben|cleo/i, 'the feed shows no names');
    await shot(leader, 'feed');
    await shot(leader, 'feed', 390);

    // The shelve path: Ben posts, the leader shelves with a reason.
    const second = await postProblem(ben, 'Two spreadsheets hold the same list.');
    await leader.goto(second);
    await leader
      .locator('form[data-event=shelved] [name=reason]')
      .fill('We already pay for a tool that does this.');
    await leader.locator('form[data-event=shelved] button').click();
    await leader.getByText('This was shelved: We already pay for a tool that does this.').waitFor();
    await shot(leader, 'item-shelved');

    // Hostile text is shown as text and never runs.
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
    const third = await postProblem(maya, evil);
    await maya.goto(third);
    assert.equal(await maya.evaluate(() => window.__xss), undefined, 'posted text must not run');
    assert.match(await maya.locator('h1').innerText(), /<img src=x/);
    await leader.goto(origin);
    assert.equal(await leader.evaluate(() => window.__xss), undefined, 'the feed must not run it');

    assert.deepEqual(problems, [], `browser problems:\n${problems.join('\n')}`);
    console.log(
      'PASS: manual path to Helps and to Shelved in a real browser, roles enforced, hostile text inert.',
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}
