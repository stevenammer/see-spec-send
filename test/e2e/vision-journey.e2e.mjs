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
  for (const name of ['olive', 'maya', 'ben', 'cara'])
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

  // Wait, reloading, until at least `count` Effort comments show on the page.
  const agentComments = page => page.locator('li > p:has-text("Effort, AI")');
  async function waitForAgentComments(page, count, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      if ((await agentComments(page).count()) >= count) return;
      if (Date.now() > end) throw new Error(`never saw ${count} Effort comments at ${page.url()}; saw ${await agentComments(page).count()}. Effort jobs: ${(await page.locator('main > p:has-text("Effort:")').allInnerTexts()).join(' / ')}. Problems: ${problems.join(' | ')}`);
      await new Promise(resolve => setTimeout(resolve, 700));
      await page.reload();
    }
  }

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

    // 3b. A mention asks Effort for a reply: a threaded-after AI comment with the fixture label.
    const mention = '@effort what is the risk here?';
    await maya.locator('form[data-event=commented] [name=comment]').first().fill(mention);
    await maya.locator('form[data-event=commented]').first().getByRole('button', { name: 'Post comment' }).click();
    await maya.getByText(mention).first().waitFor();
    await waitForAgentComments(maya, 2);
    const agentLines = await agentComments(maya).allInnerTexts();
    assert.equal(agentLines.length, 2, 'the first comment and exactly one reply to the mention');
    assert.match(agentLines[1], /effort \(Effort, AI\)/);
    assert.match(agentLines[1], /Fixture/i, 'the tagged reply must say it is a fixture');
    const order = await maya.locator('li > p').allInnerTexts();
    assert.ok(order.findIndex(line => line.includes(mention)) < order.findLastIndex(line => line.includes('Effort, AI')), "Effort's reply comes after the mention");
    step('@effort mention got a labeled AI reply');

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

    // 4b. The credit and the diff show in the SEE history; Paraphrase makes another credited revision.
    const v2 = olive.locator('li:has-text("SEE v2:")').first();
    assert.match(await v2.textContent(), /credit: paraphrased/);
    assert.match(await v2.locator('details').textContent(), /What changed[\s\S]*added: Callers lose context when a call is transferred, and repeat their account number\./);
    assert.match(await v2.locator('details').textContent(), /removed: Callers lose context when a call is transferred\./);
    const paraphrase = olive.locator('li:has-text("@effort what is the risk")').filter({ has: olive.locator('form[data-include]') }).first().locator('form[data-include]');
    await paraphrase.locator('[name=text]').fill('Callers lose context on transfer, and nobody says what the risk is.');
    await paraphrase.getByRole('button', { name: 'Paraphrase' }).click();
    await olive.getByText('SEE v3:').waitFor();
    assert.match(await olive.locator('li:has-text("SEE v3:")').first().textContent(), /credit: paraphrased/);
    assert.equal(await olive.locator('li:has(> p:has-text("Effort, AI")) form[data-include]').count(), 0, "Effort's own comments cannot be included as credit");
    step('SEE history shows credit: paraphrased and What changed');

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

    assert.match(await olive.locator('li > p:has-text("Effort, AI")').first().innerText(), /Use as starting point/);
    step('spec post shows Effort\'s Use as starting point comment');

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

    // 12. The OP page has no way to delete or hide Effort's comment, and a direct erase is refused.
    await olive.goto(itemUrl);
    const effortItem = olive.locator('li:has(> p:has-text("Effort, AI"))').first();
    const effortButtons = (await effortItem.locator('button').allInnerTexts()).map(text => text.trim());
    assert.deepEqual(effortButtons, ['Reply'], `Effort's comment offers only Reply, saw ${effortButtons}`);
    assert.equal(await olive.getByRole('button', { name: /delete|hide|remove|erase/i }).count(), 0, 'no delete or hide control anywhere on the OP page');
    const effortHash = await effortItem.locator('input[name=parent]').inputValue();
    for (const [who, page] of [['OP', olive], ['member', ben], ['leader', leader]]) {
      const erase = await rawPost(page, `/api/items/${itemId}/events`, { type: 'erased', body_hash: effortHash });
      assert.ok(erase >= 400, `${who} cannot erase Effort's comment, got ${erase}`);
    }
    await olive.goto(itemUrl);
    assert.ok((await agentComments(olive).count()) >= 2, "Effort's comments are still there");
    step("no delete or hide for Effort's comment");

    // 13. A leader reassigns the original poster with a note; the old poster's credit stays.
    await ben.goto(itemUrl);
    assert.equal(await ben.locator('form[data-event=steward_changed]').count(), 0, 'a member has no reassign control');
    assert.equal(await olive.locator('form[data-event=steward_changed]').count(), 0, 'the original poster has no reassign control');
    for (const [who, page] of [['member', ben], ['original poster', olive]]) {
      const refusedReassign = await rawPost(page, `/api/items/${itemId}/events`, { type: 'steward_changed', steward: 'maya', reason: 'I would like to hand this over.' });
      assert.ok(refusedReassign >= 400, `${who} direct reassign must be refused, got ${refusedReassign}`);
    }
    await leader.goto(itemUrl);
    const reassign = leader.locator('form[data-event=steward_changed]');
    await reassign.locator('[name=steward]').fill('maya');
    await reassign.locator('[name=reason]').fill('too short');
    await reassign.getByRole('button', { name: 'Reassign the original poster' }).click();
    assert.equal(await leader.getByText('reassigned the original poster').count(), 0, 'a short note does not reassign');
    await reassign.locator('[name=reason]').fill('Olive is moving to another team, Maya owns this now.');
    await reassign.getByRole('button', { name: 'Reassign the original poster' }).click();
    await leader.getByText(/reassigned the original poster to maya\. Note: Olive is moving to another team, Maya owns this now\./).waitFor();
    await olive.goto(itemUrl);
    assert.equal(await olive.locator('form[data-event=revised]').count(), 0, 'the old poster can no longer revise');
    assert.ok(await olive.getByText('olive posted this SEE').count() > 0, "the old poster's own post is still credited");
    assert.match(await olive.locator('li:has-text("SEE v2:")').first().textContent(), /credit: paraphrased/, 'earlier credit remains');
    await maya.goto(itemUrl);
    assert.equal(await maya.locator('form[data-event=revised]').count(), 1, 'the new poster can revise');
    step('leader reassigned the original poster with a note; credit remains');

    // 14. Mention cap: the 11th mention by one person in one day still lands, with no Effort reply.
    await join_('cara');
    await olive.goto(`${origin}/items/new`);
    await olive.locator('[name=original]').fill('New hires cannot find the transfer script.');
    await olive.getByRole('button', { name: 'Post SEE' }).click();
    await olive.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const capUrl = olive.url();
    const capId = capUrl.split('/').at(-1);
    await waitForAgentComments(olive, 1);
    await people.cara.goto(capUrl);
    const seeAnchor = await people.cara.locator('form[data-event=commented] [name=anchor_hash]').first().inputValue();
    for (let n = 1; n <= 11; n += 1) {
      const status = await rawPost(people.cara, `/api/items/${capId}/events`, { type: 'commented', comment: `@effort ping number ${n}`, anchor_kind: 'see', anchor_hash: seeAnchor, kind: 'comment' });
      assert.ok(status < 300, `mention ${n} must land, got ${status}`);
    }
    // Effort's jobs are listed on the page. Wait for every one of them to finish, then count.
    const jobLines = () => olive.locator('main > p:has-text("Effort:")').allInnerTexts();
    for (let tries = 0; ; tries += 1) {
      const lines = await jobLines();
      if (lines.length >= 11 && lines.every(line => /is (done|failed|blocked)/.test(line))) break;
      assert.ok(tries < 120, `Effort jobs never finished: ${lines.join(' / ')}`);
      await new Promise(resolve => setTimeout(resolve, 700));
      await olive.reload();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    await olive.reload();
    const tagJobs = (await jobLines()).filter(line => line.startsWith('Effort: tag'));
    assert.equal(tagJobs.length, 10, `ten mentions are answered and the 11th is not queued: ${tagJobs.join(' / ')}`);
    assert.equal((await jobLines()).length, 11, 'one first-comment job plus ten tag jobs, nothing for the 11th');
    assert.ok((await agentComments(olive).count()) >= 10, 'Effort answered the mentions under the cap');
    assert.ok((await agentComments(olive).count()) <= 11, 'never more than the first comment plus ten replies');
    assert.equal(await olive.locator('li > p:has-text("@effort ping number 11")').count(), 1, 'the 11th mention still landed');
    step('11th @effort mention landed with no Effort reply');

    // 15. Vision Quest, finished with a BUILD recommendation (not CONFIGURE), opens as a SEE with Effort's first reply.
    await maya.goto(`${origin}/quest`);
    const picks = { have: 'unavailable', pay_for: 'unavailable', free: 'unavailable', setting: 'unavailable', playback: 'yes', risk: 'low', impact: '4', repeat: '4', control: '4', evidence: '4', approach: 'build' };
    const questForm = '#quest-content > form[data-quest-step]';
    await maya.locator(questForm).waitFor();
    for (let guard = 0; guard < 60; guard += 1) {
      const form = maya.locator(questForm);
      if (!(await form.count())) break;
      const key = await form.getAttribute('data-quest-step');
      const field = form.locator('[name=answer]');
      if (picks[key]) await field.selectOption(picks[key]); else await field.fill(`${key}: transfers drop the account number every time on a real call`);
      await form.getByRole('button', { name: 'Save answer and continue' }).click();
      await maya.waitForFunction(previous => document.querySelector('#quest-content > form[data-quest-step]')?.dataset.questStep !== previous, key, { timeout: 8000 }).catch(() => {});
    }
    await maya.getByRole('heading', { name: 'BUILD', exact: true }).waitFor({ timeout: 8000 });
    await maya.locator('[name=reviewed]').check();
    await maya.getByRole('button', { name: 'Post my checked problem' }).click();
    await maya.waitForURL(/\/items\/[^/]+$/);
    await maya.getByRole('heading', { name: 'Original' }).waitFor();
    await maya.getByRole('heading', { name: 'Vision Quest memo' }).waitFor();
    await waitForAgentComments(maya, 1);
    assert.match(await agentComments(maya).first().innerText(), /Fixture/i);
    step('Vision Quest (BUILD) opened as a SEE with an Effort first reply');

    assert.deepEqual(problems, [], `browser problems:\n${problems.join('\n')}`);
    console.log('PASS: Vision journey in a real browser: SEE, Effort, mention, include and credit, SPEC IT!, SEND IT!, decision, fork, adopted steer, reassign, mention cap, Vision Quest.');
  } finally {
    await browser.close();
    for (const child of children) child.kill('SIGTERM');
  }
}
