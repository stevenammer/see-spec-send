// Real-browser walkthrough of the Vision journey. Run outside any sandbox:
//   PLAYWRIGHT_DIR=/path/to/node_modules npm run test:vision
// It starts the real server (Effort on the in-process fixture provider) and the fake-builder worker,
// signs in four people through the real screens and walks one item from SEE to a steered try.
// It is skipped under `node --test`.
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
  const db = join(mkdtempSync(join(tmpdir(), 'sss-vision-')), 'sss.db');
  const port = 18000 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SSS_DB: db };

  const cli = args =>
    new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      const child = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env });
      child.stdout.on('data', chunk => (out += chunk));
      child.stderr.on('data', chunk => (err += chunk));
      child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(err || out))));
    });

  // The first account from `init` carries a temporary password that has no screen to change it,
  // so the leader joins by a leader invite instead. `init` still creates the first admin.
  await cli(['init', '--id', 'admin']);
  await cli(['gateway', 'fixture-enable']);
  const invites = { leader: await cli(['invite', 'create', '--role', 'leader']) };
  for (const name of ['olive', 'maya', 'ben'])
    invites[name] = await cli(['invite', 'create', '--role', 'member']);

  const children = [];
  const server = spawn(
    process.execPath,
    ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies', '--enable-effort', '--fixture'],
    { cwd: root, env },
  );
  const worker = spawn(process.execPath, ['cli.js', 'worker'], { cwd: root, env });
  children.push(server, worker);
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
    await page.getByRole('link', { name: 'Post a problem' }).waitFor({ timeout: 8000 });
  }

  // Reload until the text shows up, because Effort and the worker run in other processes.
  async function eventually(page, locator, what, timeout = 20000) {
    const end = Date.now() + timeout;
    for (;;) {
      if ((await page.locator(locator).count()) > 0) return;
      if (Date.now() > end) {
        const text = (await page.locator('body').innerText()).slice(0, 600);
        throw new Error(`never saw ${what} at ${page.url()}. Page said: ${text}. Problems: ${problems.join(' | ')}`);
      }
      await new Promise(resolve => setTimeout(resolve, 700));
      await page.reload();
    }
  }

  // A direct POST, the way a script would send it, with the page's own session.
  const rawPost = (page, path, body) =>
    page.evaluate(
      async ({ path, body }) => {
        const me = await (await fetch('/api/me')).json();
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
          body: JSON.stringify(body),
        });
        return response.status;
      },
      { path, body },
    );

  const step = (name) => process.stdout.write(`  ok ${name}\n`);

  try {
    await waitForServer();
    for (const name of ['leader', 'olive', 'maya', 'ben']) await join_(name);
    const { leader, olive, maya, ben } = people;
    const leaderPassword = 'leader-long-password-9x';

    // 1. OP posts a SEE directly, skipping Vision Quest.
    await olive.goto(`${origin}/items/new`);
    await olive.locator('[name=original]').fill('Callers lose context when a call is transferred.');
    await olive.getByRole('button', { name: 'Post SEE' }).click();
    await olive.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const itemUrl = olive.url();
    const itemId = itemUrl.split('/').at(-1);
    await olive.getByRole('heading', { name: 'Original' }).waitFor();
    step('OP posted a SEE');

    // 2. Effort's first comment: shown as AI, and labeled as a fixture.
    await eventually(olive, 'li:has-text("Effort, AI")', "Effort's first comment");
    const effortLine = await olive.locator('li:has-text("Effort, AI")').first().innerText();
    assert.match(effortLine, /effort \(Effort, AI\)/);
    assert.match(effortLine, /Fixture/i, 'fixture output must say it is a fixture');
    step('Effort commented first, labeled AI and fixture');

    // 3. A member comments.
    await maya.goto(itemUrl);
    await maya.locator('form[data-event=commented] [name=comment]').first().fill('Does the caller repeat their account number?');
    await maya.locator('form[data-event=commented]').first().getByRole('button', { name: 'Post comment' }).click();
    await maya.getByText('Does the caller repeat their account number?').first().waitFor();
    step('member commented');

    // 4. Only OP can include it.
    assert.equal(await maya.locator('form[data-include]').count(), 0, 'a member sees no Include control');
    await ben.goto(itemUrl);
    assert.equal(await ben.locator('form[data-include]').count(), 0, 'another member sees no Include control');
    const mayaHash = await olive.reload().then(() => olive.locator('li:has-text("Does the caller repeat") form[data-include] [name=comment]').first().inputValue());
    const baseHash = await olive.locator('form[data-event=revised] [name=base_hash]').inputValue();
    const refused = await rawPost(maya, `/api/items/${itemId}/events`, {
      type: 'revised', text: 'Maya rewrote it.', base_hash: baseHash, credits: [{ comment: mayaHash, mode: 'paraphrased' }],
    });
    assert.ok(refused >= 400, `a member's direct revise must be refused, got ${refused}`);
    await olive.reload();
    assert.equal(await olive.locator('li:has-text("Maya rewrote it.")').count(), 0);
    const include = olive.locator('li:has-text("Does the caller repeat") form[data-include]').first();
    await include.locator('[name=text]').fill('Callers lose context when a call is transferred, and repeat their account number.');
    await include.getByRole('button', { name: 'Include' }).click();
    await olive.getByText('SEE v2:').waitFor();
    step('OP included the comment; member refused');

    // 5. SPEC IT! makes the spec post, where Effort comments first too.
    await olive.locator('form[data-event=specced] [name=must]').fill('Pass the account number on transfer.\nShow it to the next agent.');
    await olive.locator('form[data-event=specced] [name=how_we_know]').fill('Callers stop repeating it.');
    await olive.getByRole('button', { name: 'SPEC IT!' }).click();
    await olive.getByRole('link', { name: 'Open the spec' }).waitFor();
    await olive.goto(`${itemUrl}/spec`);
    await olive.getByRole('heading', { name: 'Spec v1' }).waitFor();
    await eventually(olive, 'li:has-text("Effort, AI")', "Effort's first spec comment");
    assert.match(await olive.locator('li:has-text("Effort, AI")').first().innerText(), /Fixture/i);
    step('spec post and Effort comment');

    // 6. SEND IT!
    await olive.getByRole('button', { name: 'SEND IT!' }).click();
    await olive.waitForFunction(() => !document.querySelector('form[data-send]'));
    await olive.goto(itemUrl);
    await olive.locator('.stage', { hasText: 'Decide' }).waitFor();
    step('SEND IT!');

    // 7. The OP cannot approve; a direct POST is refused too.
    assert.equal(await olive.locator('form[data-approve]').count(), 0, 'OP has no approve control');
    const specHash = await leader.goto(itemUrl).then(() => leader.locator('form[data-approve] [name=spec_hash]').inputValue());
    const packetHash = await leader.locator('form[data-approve] [name=packet_hash]').inputValue();
    const opApprove = await rawPost(olive, `/api/items/${itemId}/events`, {
      type: 'approved', spec_hash: specHash, packet_hash: packetHash, reason: 'I approve my own work.', cap_usd: 1, quorum: 1,
    });
    assert.ok(opApprove >= 400, `OP direct approve must be refused, got ${opApprove}`);
    step('OP cannot approve');

    // 8. A different leader reads the packet and approves with a reason and step-up.
    await leader.getByRole('heading', { name: 'Decision packet' }).waitFor();
    await ben.goto(itemUrl);
    await ben.getByRole('heading', { name: 'Decision packet' }).waitFor();
    assert.equal(await ben.locator('form[data-approve]').count(), 0, 'a member has no approve control');
    const reason = 'Small enough to try and the spec is clear.';
    await leader.locator('form[data-approve] [name=reason]').fill(reason);
    await leader.locator('form[data-approve] [name=cap_usd]').fill('2');
    await leader.locator('form[data-approve] [name=quorum]').fill('1');
    await leader.locator('form[data-approve] [name=password]').fill(leaderPassword);
    await leader.locator('form[data-approve] button').click();
    await leader.locator('.stage', { hasText: /Send/ }).waitFor();
    await ben.goto(itemUrl);
    await ben.getByText(reason).first().waitFor();
    step('leader approved with reason and step-up; member sees the reason');

    // 9. A member forks. The fork names its parent and has no approval and no build.
    await ben.locator('form[data-fork] [name=reason]').fill('Try passing it through the transfer screen instead.');
    await ben.getByRole('button', { name: 'Fork', exact: true }).click();
    await ben.waitForURL(url => url.href !== itemUrl && /\/items\/[^/]+$/.test(url.pathname));
    await ben.getByText('Forked from').first().waitFor();
    assert.equal(await ben.locator('form[data-approve]').count(), 0, 'a fork has no approval');
    assert.equal(await ben.locator('iframe').count(), 0, 'a fork has no build');
    assert.equal(await ben.locator('form[data-artifact]').count(), 0, 'a fork has no delivery');
    step('fork shows Forked from, no approval, no build');

    // 10. The fake builder delivers a try for the parent.
    await olive.goto(itemUrl);
    await eventually(olive, 'iframe[title="Playable try"]', 'the first try', 30000);
    step('fake builder delivered a try');

    // 11. A member comments in the try thread; the OP adopts it as a builder instruction.
    await maya.goto(itemUrl);
    const adoptable = 'Show the account number in bold.';
    const ignored = 'Also make everything purple.';
    for (const text of [adoptable, ignored]) {
      await maya.getByLabel('Comment on this try').fill(text);
      await maya.locator('form[data-event=commented]', { has: maya.getByLabel('Comment on this try') }).getByRole('button', { name: 'Post comment' }).click();
      await maya.getByText(text).first().waitFor();
    }
    assert.equal(await maya.locator('form[data-adopt]').count(), 0, 'a member sees no Adopt control');
    await olive.goto(itemUrl);
    const row = olive.locator('li', { hasText: adoptable }).filter({ has: olive.locator('form[data-adopt]') }).last();
    await row.locator('form[data-adopt]').first().getByRole('button', { name: 'Adopt as builder instruction' }).click();
    await olive.getByRole('heading', { name: 'Builder instructions' }).waitFor();
    await eventually(olive, 'iframe[title="Playable try"]', 'the next try', 30000);
    const frame = olive.frameLocator('iframe[title="Playable try"]');
    await frame.locator('body').getByText(adoptable).waitFor({ timeout: 20000 });
    assert.equal(await frame.locator('body').getByText(ignored).count(), 0, 'a non-adopted comment must not reach the builder');
    assert.equal(await olive.locator('section:has(h2:text("Builder instructions")) li', { hasText: ignored }).count(), 0);
    step('adopted comment reached the next try; the other did not');

    assert.deepEqual(problems, [], `browser problems:\n${problems.join('\n')}`);
    console.log('PASS: Vision journey in a real browser: SEE, Effort, include, SPEC IT!, SEND IT!, decision, fork, adopted steer.');
  } finally {
    await browser.close();
    for (const child of children) child.kill('SIGTERM');
  }
}
