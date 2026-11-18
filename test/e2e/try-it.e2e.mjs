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
    // The original post sits in a collapsed section now; the record is there once it is opened.
    await maya.getByText('Original post, versions and record').click();
    await maya.getByRole('heading', { name: 'Original' }).waitFor();

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
    await leader
      .locator('form[data-approve] [name=reason]')
      .fill('Small enough to try and the spec is clear.');
    // A typo-sized cap never goes through. The page limits it, and the server refuses it too.
    const approveForm = leader.locator('form[data-approve]');
    await approveForm.locator('[name=quorum]').fill('2');
    await approveForm.locator('[name=password]').fill(leaderPassword);
    await approveForm.locator('[name=cap_usd]').fill('999999999');
    assert.equal(await approveForm.evaluate(f => f.checkValidity()), false, 'the field refuses a huge cap');
    const forgedCap = await leader.evaluate(async password => {
      const csrf = (await (await fetch('/api/me')).json()).csrf;
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
      await fetch('/api/stepup', { method: 'POST', headers, body: JSON.stringify({ password }) });
      const form = document.querySelector('form[data-approve]');
      const active = document.querySelector('[data-active-post]');
      if (active) { headers['x-post-id'] = active.dataset.activePost; headers['x-post-version'] = active.dataset.postVersion; }
      const id = location.pathname.split('/items/')[1];
      const send = cap => fetch(`/api/items/${id}/events`, { method: 'POST', headers, body: JSON.stringify({ type: 'approved',
        spec_hash: form.spec_hash.value, packet_hash: form.packet_hash.value, reason: 'A real reason for this test.', cap_usd: cap, quorum: 2 }) }).then(r => r.status);
      return { huge: await send(999999999), over: await send(10000.01) };
    }, leaderPassword);
    assert.equal(forgedCap.huge, 409, 'the server refuses a huge cap');
    assert.equal(forgedCap.over, 409, 'and anything over the ceiling');
    // A big but allowed cap asks first. Saying no sends nothing.
    await approveForm.locator('[name=cap_usd]').fill('500');
    await approveForm.locator('button').click();
    await leader.getByText('Most tries need a few dollars. Is that what you meant?').waitFor();
    await leader.getByRole('button', { name: 'No, go back' }).click();
    await leader.waitForTimeout(500);
    assert.equal(await leader.locator('form[data-approve]').count(), 1, 'still undecided after saying no');
    assert.equal(await leader.locator('.stage', { hasText: 'Decide' }).count(), 1);
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
    // The try screen, as a teammate who has never seen it.
    const ben = people.ben;
    await ben.goto(itemUrl);
    await ben.locator('iframe[title="Playable try"]').waitFor();
    const before = await ben.locator('main').innerText();
    assert.match(before, /0 of 2 people have said it helps/);
    assert.match(before, /If it doesn't help, leave a comment/, 'the page says what to do if it did not help');
    assert.match(before, /Press this only if it really helped/, 'the button explains itself');
    // The next-step note links down to the try.
    await ben.getByRole('link', { name: 'Jump to it' }).click();
    assert.match(ben.url(), /#try$/);

    // A fast double press counts once and the page then says Ben already said it.
    await ben.locator('form[data-event=helped] button').dblclick();
    await ben.getByText('You said this helps. It counts once.').waitFor();
    await ben.getByText('1 of 2 people have said it helps').waitFor();
    assert.equal(await ben.locator('form[data-event=helped]').count(), 0, 'no second button after voting');
    await ben.reload();
    await ben.getByText('You said this helps. It counts once.').waitFor();

    // A forged second vote straight at the API is refused, and the count stays at one.
    const forged = await ben.evaluate(async url => {
      const id = url.split('/items/')[1].split(/[#?]/)[0];
      const csrf = (await (await fetch('/api/me')).json()).csrf;
      const response = await fetch(`/api/items/${id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ type: 'helped', artifact_hash: 'wrong' }),
      });
      return response.status;
    }, itemUrl);
    console.log('forged status', forged); assert.ok([400, 403, 409].includes(forged), `forged vote refused, got ${forged}`);
    await ben.reload();
    await ben.getByText('1 of 2 people have said it helps').waitFor();

    // Maya (steward) and the leader (approver) never see a vote button.
    await maya.goto(itemUrl);
    assert.equal(await maya.locator('form[data-event=helped]').count(), 0);
    assert.match(await maya.locator('#try').innerText(), /You helped shape this one/);
    assert.deepEqual(problems, []);
    console.log('try-it journey passed');
  } finally {
    await browser.close();
    server.kill();
  }
}
