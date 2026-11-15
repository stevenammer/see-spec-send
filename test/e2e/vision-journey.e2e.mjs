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
    const context = await browser.newContext({ viewport: name === 'ben' ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
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
    const mentionThread = maya.locator('li').filter({ has: maya.locator('p', { hasText: mention }) }).first();
    assert.equal(await mentionThread.locator('li:has-text("Effort, AI")').count(), 1, 'the mention reply remains in its exact nested thread');
    assert.match(await maya.locator('main').textContent(), /You can request 9 more mention replies; this item can accept 29 more/);
    assert.match(await maya.locator('main').textContent(), /Model calls for mentions and SPEC drafts: 9 remaining for you, 29 for this item/);
    step('@effort mention got a nested labeled AI reply and actual remaining allowances');

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
    await include.locator('[name=text]').fill('Callers lose context when a call is transferred. Does the caller repeat their account number?');
    await include.getByRole('button', { name: 'Include' }).click();
    await olive.getByText('SEE v2:').waitFor();
    step('OP included the comment; member refused');

    // 4b. The credit and the diff show in the SEE history; Paraphrase makes another credited revision.
    const v2 = olive.locator('li:has-text("SEE v2:")').first();
    assert.match(await v2.textContent(), /credit: maya, quoted/);
    assert.match(await v2.locator('details').textContent(), /What changed[\s\S]*added: Callers lose context when a call is transferred\. Does the caller repeat their account number\?/);
    assert.match(await v2.locator('details').textContent(), /removed: Callers lose context when a call is transferred\./);
    const paraphrase = olive.locator('li:has-text("@effort what is the risk")').filter({ has: olive.locator('form[data-include]') }).first().locator('form[data-include]');
    await paraphrase.locator('[name=text]').fill('Callers lose context on transfer, and nobody says what the risk is.');
    await paraphrase.getByRole('button', { name: 'Paraphrase' }).click();
    await olive.getByText('SEE v3:').waitFor();
    assert.match(await olive.locator('li:has-text("SEE v3:")').first().textContent(), /credit: maya, paraphrased/);
    assert.equal(await olive.locator('li:has(> p:has-text("Effort, AI")) form[data-include]').count(), 0, "Effort's own comments cannot be included as credit");
    step('SEE history shows credit: paraphrased and What changed');

    // 5. Draft from the current curated SEE, then deliberately edit and publish.
    assert.ok(await rawPost(maya, `/api/items/${itemId}/spec-draft`, { see_hash: await olive.locator('form[data-spec-prepare] [name=see_hash]').inputValue() }) >= 400);
    await olive.getByRole('button', { name: 'Draft SPEC for review' }).click();
    await eventually(olive, '[data-spec-draft]', 'reviewable structured SPEC draft');
    await olive.getByRole('button', { name: 'Review AI draft in the spec form' }).click();
    assert.match(await olive.locator('form[data-event=specced] [name=must]').inputValue(), /Fixture draft/);
    assert.match(await olive.locator('form[data-event=specced] [name=assumptions]').inputValue(), /no model has investigated/);
    assert.equal(await olive.getByRole('link', { name: 'Open the spec', exact: true }).count(), 0, 'reviewing the draft has not published a SPEC');
    await olive.locator('form[data-event=specced] [name=must]').fill('Pass the account number on transfer.\nShow it to the next agent.');
    await olive.locator('form[data-event=specced] [name=how_we_know]').fill('Callers stop repeating it.');
    await olive.locator('form[data-event=specced] [name=assumptions]').fill('The transfer system can display a note.');
    await olive.locator('form[data-event=specced] [name=open_questions]').fill('Who maintains the note after a transfer?');
    await olive.getByRole('button', { name: 'SPEC IT!' }).click();
    await olive.getByRole('link', { name: 'Open the spec' }).waitFor();
    await olive.goto(`${itemUrl}/spec`);
    await olive.getByRole('heading', { name: 'Spec v1' }).waitFor();
    await eventually(olive, 'li:has-text("Effort, AI")', "Effort's first spec comment");
    assert.match(await olive.locator('li:has-text("Effort, AI")').first().innerText(), /Fixture/i);
    step('spec post and Effort comment');

    assert.match(await olive.locator('li > p:has-text("Effort, AI")').first().innerText(), /Use as starting point/);
    step('spec post shows Effort\'s Use as starting point comment');

    // 5b. SPEC Include is a real click, distinct from Paraphrase, and binds the current spec version.
    await maya.goto(`${itemUrl}/spec`);
    await maya.locator('form[data-event=commented] [name=comment]').first().fill('Keep the caller name with the transfer.');
    await maya.locator('form[data-event=commented]').first().getByRole('button', { name: 'Post comment' }).click();
    await maya.getByText('Keep the caller name with the transfer.').first().waitFor();
    await olive.goto(`${itemUrl}/spec`);
    const specInclude = olive.locator('li:has-text("Keep the caller name") form[data-include="spec"]');
    await specInclude.getByRole('button', { name: 'Include' }).click();
    await olive.getByRole('heading', { name: 'Spec v2' }).waitFor();
    assert.equal(await olive.locator('form[data-event=specced] [name=must]').inputValue(), 'Pass the account number on transfer.\nShow it to the next agent.\nKeep the caller name with the transfer.');
    assert.equal(await olive.locator('form[data-event=specced] [name=how_we_know]').inputValue(), 'Callers stop repeating it.');
    assert.equal(await olive.locator('form[data-event=specced] [name=assumptions]').inputValue(), 'The transfer system can display a note.');
    assert.equal(await olive.locator('form[data-event=specced] [name=open_questions]').inputValue(), 'Who maintains the note after a transfer?');
    step('SPEC Include clicked and created a version-bound spec update, preserving assumptions and open questions');

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
    await leader.locator('form[data-approve] [name=max_iterations]').fill('2');
    await leader.locator('form[data-approve] [name=window_minutes]').fill('60');
    await leader.locator('form[data-approve] [name=password]').fill(leaderPassword);
    await leader.locator('form[data-approve] button').click();
    await leader.locator('.stage', { hasText: /Send/ }).waitFor();
    await ben.goto(itemUrl);
    await ben.getByText(reason).first().waitFor();
    assert.match(await ben.locator('main').innerText(), /up to 2 additional build turns, 60 minutes/i);
    assert.match(await ben.locator('main').innerText(), /Cap: \$2\.00/);
    step('leader approved with a configurable leash and password step-up; member sees reason and bounds');

    // 9. A member forks an older spec on a phone, retaining only an explicitly unapproved draft.
    await ben.goto(`${itemUrl}/spec`);
    const selectedFrom = await ben.locator('form[data-fork] option', { hasText: 'Spec v1 (historical)' }).getAttribute('value');
    await ben.locator('form[data-fork] [name=from]').selectOption(selectedFrom);
    const oldSpec = await ben.evaluate(async ({ itemId, hash }) => {
      const data = await (await fetch(`/api/items/${itemId}`)).json();
      return data.events.find(event => event.body_hash === hash);
    }, { itemId, hash: selectedFrom.split(':')[1] });
    await ben.locator('form[data-fork] [name=reason]').fill('Try passing it through the transfer screen instead.');
    await ben.getByRole('button', { name: 'Fork', exact: true }).click();
    await ben.waitForURL(url => url.href !== itemUrl && /\/items\/[^/]+$/.test(url.pathname));
    await ben.getByText('Forked from').first().waitFor();
    assert.equal(await ben.locator('form[data-approve]').count(), 0, 'a fork has no approval');
    assert.equal(await ben.locator('iframe').count(), 0, 'a fork has no build');
    assert.equal(await ben.locator('form[data-artifact]').count(), 0, 'a fork has no delivery');
    await ben.getByRole('heading', { name: 'Fork starting spec (unapproved draft)' }).waitFor();
    assert.equal(await ben.locator('form[data-event=specced] [name=must]').inputValue(), oldSpec.must.join('\n'));
    assert.equal(await ben.locator('form[data-send]').count(), 0, 'draft has not become a saved spec');
    assert.equal(ben.viewportSize().width, 390);
    step('phone member forked a historical spec as an unapproved draft, with no inherited approval or build');

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

    // 13. Reassignment needs recorded OP consent; the originator's credit stays.
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
    await reassign.getByRole('button', { name: 'Reassign steward' }).click();
    assert.equal(await leader.getByText('reassigned the steward').count(), 0, 'a short note does not reassign');
    await reassign.locator('[name=reason]').fill('Olive is moving to another team, Maya owns this now.');
    const deniedReassign = leader.waitForResponse(response => response.url().endsWith(`/api/items/${itemId}/events`) && response.request().method() === 'POST');
    await reassign.getByRole('button', { name: 'Reassign steward' }).click();
    assert.ok((await deniedReassign).status() >= 400, 'reassignment without consent is refused before proceeding');
    await reassign.locator('[role=alert]').waitFor();
    assert.equal(await leader.getByText('reassigned the steward').count(), 0, 'a leader cannot bypass the fourteen-day consent rule');
    assert.equal(await rawPost(olive, `/api/items/${itemId}/events`, { type: 'checked_in', note: 'I consent to Maya taking this work.', consent: true }), 201);
    await leader.reload();
    await leader.locator('form[data-event=steward_changed] [name=steward]').fill('maya');
    await leader.locator('form[data-event=steward_changed] [name=reason]').fill('Olive is moving to another team, Maya owns this now.');
    await leader.locator('form[data-event=steward_changed]').getByRole('button', { name: 'Reassign steward' }).click();
    await leader.getByText(/reassigned the steward to maya\. Note: Olive is moving to another team, Maya owns this now\./).waitFor();
    await olive.goto(itemUrl);
    assert.equal(await olive.locator('form[data-event=revised]').count(), 0, 'the old poster can no longer revise');
    assert.ok(await olive.getByText('olive posted this SEE').count() > 0, "the old poster's own post is still credited");
    assert.match(await olive.locator('li:has-text("SEE v2:")').first().textContent(), /credit: maya, quoted/, 'earlier credit remains');
    await maya.goto(itemUrl);
    assert.equal(await maya.locator('form[data-event=revised]').count(), 1, 'the new poster can revise');
    step('leader reassigned the steward with a note; originator credit remains');

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
      if (lines.length >= 11 && lines.every(line => /is (answered|unavailable, retries exhausted|done|failed|blocked)/.test(line))) break;
      assert.ok(tries < 120, `Effort jobs never finished: ${lines.join(' / ')}`);
      await new Promise(resolve => setTimeout(resolve, 700));
      await olive.reload();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    await olive.reload();
    const tagJobs = (await jobLines()).filter(line => line.startsWith('Effort: tag'));
    assert.equal(tagJobs.length, 10, `ten mentions are answered and the 11th is not queued: ${tagJobs.join(' / ')}`);
    assert.equal((await jobLines()).length, 11, 'one first-comment job plus ten tag jobs, nothing for the 11th');
    assert.ok((await agentComments(olive).count()) >= 10, `Effort answered the mentions under the cap (saw ${await agentComments(olive).count()}): ${(await jobLines()).join(' / ')}`);
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

    // 16. F-01 / REG-02: a plain comment and a check-in leave a delivered try alone; a SEE revision supersedes it.
    await olive.goto(`${origin}/items/new`);
    await olive.locator('[name=original]').fill('Agents re-key the caller phone number after every transfer.');
    await olive.getByRole('button', { name: 'Post SEE' }).click();
    await olive.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const regUrl = olive.url();
    const regId = regUrl.split('/').at(-1);
    await olive.locator('form[data-event=specced] [name=must]').fill('Carry the phone number across the transfer.');
    await olive.locator('form[data-event=specced] [name=how_we_know]').fill('Agents stop re-keying it.');
    await olive.getByRole('button', { name: 'SPEC IT!' }).click();
    await olive.getByRole('link', { name: 'Open the spec' }).waitFor();
    await olive.goto(`${regUrl}/spec`);
    await olive.getByRole('button', { name: 'SEND IT!' }).click();
    await olive.waitForFunction(() => !document.querySelector('form[data-send]'));
    await leader.goto(regUrl);
    const regReason = 'Small and clear, worth one try.';
    await leader.locator('form[data-approve] [name=reason]').fill(regReason);
    await leader.locator('form[data-approve] [name=cap_usd]').fill('2');
    await leader.locator('form[data-approve] [name=quorum]').fill('1');
    await leader.locator('form[data-approve] [name=password]').fill(leaderPassword);
    await leader.locator('form[data-approve] button').click();
    await leader.locator('.stage', { hasText: /Send/ }).waitFor();
    await olive.goto(regUrl);
    await eventually(olive, 'iframe[title="Playable try"]', 'the REG-02 try', 30000);
    const regArtifact = await ben.goto(regUrl).then(() => ben.locator('form[data-event=helped] [name=artifact_hash]').inputValue());
    const feedback = 'Please keep the number visible after the transfer.';
    await maya.goto(regUrl);
    await maya.getByLabel('Comment on this try').fill(feedback);
    await maya.locator('form[data-event=commented]', { has: maya.getByLabel('Comment on this try') }).getByRole('button', { name: 'Post comment' }).click();
    await maya.getByText(feedback).first().waitFor();
    assert.equal(await rawPost(maya, `/api/items/${regId}/events`, { type: 'commented', comment: 'A plain comment on the SEE.', kind: 'comment', anchor_kind: 'see', anchor_hash: await maya.locator('form[data-event=commented] [name=anchor_hash]').last().inputValue() }), 201);
    assert.equal(await rawPost(maya, `/api/items/${regId}/events`, { type: 'checked_in', note: 'Still watching how this one goes.' }), 201);
    await olive.goto(regUrl);
    await olive.locator('iframe[title="Playable try"]').waitFor();
    assert.equal(await olive.locator('.stage', { hasText: /Send/ }).count() > 0, true, 'a comment and a check-in leave the item in Send');
    assert.equal(await olive.getByText('superseded').count(), 0, 'a comment and a check-in do not supersede the try');
    assert.equal(await ben.goto(regUrl).then(() => ben.locator('form[data-event=helped]').count()), 1, 'the helper can still say it helps');
    step('comment and check-in left the delivered try alone');

    // The OP revises the SEE: the old try is superseded.
    const regBase = await olive.locator('form[data-event=revised] [name=base_hash]').inputValue();
    await olive.locator('form[data-event=revised] [name=text]').fill('Agents re-key the caller phone number and the account number after every transfer.');
    await olive.locator('form[data-event=revised]').getByRole('button', { name: 'Save revision' }).click();
    await olive.getByText('SEE v2:').waitFor();
    assert.notEqual(regBase, await olive.locator('form[data-event=revised] [name=base_hash]').inputValue(), 'the revision made a new SEE hash');
    await olive.getByText('This old approval is superseded.').waitFor();
    const oldNote = await olive.locator('p:has-text("This old approval is superseded.")').innerText();
    assert.match(oldNote, /The delivered try is superseded and cannot receive new Helps votes\./);
    assert.match(oldNote, /Update the spec, SEND IT!, and get a new leader approval\./, 'the OP is told a new spec, SEND and leader approval are needed');
    assert.equal(await olive.locator('iframe[title="Playable try"]').count(), 0, 'no playable old try is offered');
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(db, { readOnly: true });
    let runs = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      runs = probe.prepare('SELECT status FROM runs WHERE item=?').all(regId);
      if (runs.length && runs.every(run => run.status === 'stopped')) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    probe.close();
    assert.ok(runs.length > 0 && runs.every(run => run.status === 'stopped'), `the old run is stopped, saw ${JSON.stringify(runs)}`);
    await ben.goto(regUrl);
    assert.equal(await ben.locator('form[data-event=helped]').count(), 0, 'a helper has no Helps control for the superseded try');
    const stale = await rawPost(ben, `/api/items/${regId}/events`, { type: 'helped', artifact_hash: regArtifact });
    assert.ok(stale >= 400 && stale < 500, `a direct Helps for the old artifact must be refused with a 4xx, got ${stale}`);
    await ben.reload();
    assert.ok(await ben.getByText(regReason).count() > 0, 'the old approval reason stays visible as history');
    assert.ok(await ben.getByText(feedback).count() > 0, 'the old try feedback stays visible as history');
    step('SEE revision superseded the try; Helps refused; history and next steps shown');

    // 17. Decisions remain public with the exact reviewed packet, even after a return and new spec.
    await olive.goto(`${origin}/items/new`);
    await olive.locator('[name=original]').fill('Transfers lose the caller preference.');
    await olive.getByRole('button', { name: 'Post SEE' }).click();
    await olive.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const decisionUrl = olive.url();
    const decisionId = decisionUrl.split('/').at(-1);
    await olive.locator('form[data-event=specced] [name=must]').fill('Carry the caller preference across.');
    await olive.locator('form[data-event=specced] [name=how_we_know]').fill('The second agent sees it.');
    await olive.getByRole('button', { name: 'SPEC IT!' }).click();
    await olive.getByRole('link', { name: 'Open the spec' }).waitFor();
    await olive.goto(`${decisionUrl}/spec`);
    const researchResponse = olive.waitForResponse(response => response.url().endsWith(`/api/items/${decisionId}/research`) && response.request().method() === 'POST');
    await Promise.all([olive.waitForEvent('load'), olive.getByRole('button', { name: 'Refresh research record' }).click()]);
    assert.equal((await researchResponse).status(), 201);
    await olive.locator('form[data-send] [name=estimate]').fill('OP estimate: one hour to test the existing handoff view.');
    await olive.getByRole('button', { name: 'SEND IT!' }).click();
    await olive.waitForFunction(() => !document.querySelector('form[data-send]'));
    await leader.goto(decisionUrl);
    const returnForm = leader.locator('form[data-event=returned]');
    const returnedPacket = await returnForm.locator('[name=packet_hash]').inputValue();
    const returnReason = 'Check the existing handoff view before adding another.';
    // Browser validity stops a short reason, and the server refuses a crafted short reason too.
    await returnForm.locator('[name=reason]').fill('short');
    await returnForm.getByRole('button', { name: 'Return the spec' }).click();
    assert.equal(await leader.locator('.stage', { hasText: 'Decide' }).count(), 1);
    assert.ok(await rawPost(leader, `/api/items/${decisionId}/events`, { type: 'returned', reason: 'short' }) >= 400);
    await returnForm.locator('[name=reason]').fill(returnReason);
    await returnForm.getByRole('button', { name: 'Return the spec' }).click();
    await leader.getByRole('heading', { name: 'Decision history' }).waitFor();
    await ben.goto(decisionUrl);
    await ben.getByText(returnReason).first().waitFor();
    assert.equal(await ben.locator('form[data-event=returned]').count(), 0);
    assert.match(await ben.locator('main').innerText(), new RegExp(returnedPacket));
    await ben.getByText('Reviewed evidence snapshot', { exact: true }).click();
    assert.match(await ben.locator('main').innerText(), /not connected/);
    assert.match(await ben.locator('main').innerText(), /one hour to test the existing handoff view/);
    step('return requires a reason and keeps its reviewed packet visible to members');

    await olive.goto(`${decisionUrl}/spec`);
    const reviseSpec = olive.locator('form[data-event=specced]');
    await reviseSpec.locator('[name=must]').fill('Use the existing handoff view for the preference.');
    await reviseSpec.getByRole('button').click();
    await olive.getByRole('heading', { name: 'Spec v2' }).waitFor();
    await olive.getByRole('button', { name: 'SEND IT!' }).click();
    await olive.waitForFunction(() => !document.querySelector('form[data-send]'));
    await leader.goto(decisionUrl);
    const notBuilt = leader.locator('form[data-event=not_built]');
    const newPacket = await notBuilt.locator('[name=packet_hash]').inputValue();
    assert.notEqual(returnedPacket, newPacket);
    const noBuildReason = 'The existing handoff view covers this without a new build.';
    await notBuilt.locator('[name=reason]').fill(noBuildReason);
    await notBuilt.locator('[name=restricted_evidence]').fill('a restricted source exists; ask Privacy');
    await notBuilt.locator('[name=pivot_note]').fill('The existing view was verified after the return.');
    await notBuilt.getByRole('button', { name: 'Not building' }).click();
    await leader.getByRole('heading', { name: 'Decision history' }).waitFor();
    await ben.goto(decisionUrl);
    await ben.getByText(noBuildReason).first().waitFor();
    assert.equal(ben.viewportSize().width, 390, 'member reads decision history at phone width');
    assert.match(await ben.locator('main').innerText(), /a restricted source exists; ask Privacy/);
    assert.match(await ben.locator('main').innerText(), /What changed: The existing view was verified after the return\./);
    assert.equal(await ben.locator('section:has(h2:text("Decision history")) > ol > li').count(), 2);
    assert.ok(await ben.getByText(returnReason).count() > 0, 'earlier return reason remains');
    assert.equal(await ben.locator('iframe[title="Playable try"]').count(), 0);
    step('Not building records a concrete reason, evidence receipt and pivot note; prior decision stays public');

    // 18. A completed/closed parent remains available as a historical fork source.
    await leader.goto(itemUrl);
    await leader.locator('form[data-event=shelved] [name=reason]').fill('Keep this trial as history while trying another direction.');
    await leader.getByRole('button', { name: 'Shelve with a reason' }).click();
    await leader.locator('.stage', { hasText: 'Shelved' }).waitFor();
    await ben.goto(itemUrl);
    await ben.locator('form[data-fork] [name=from]').selectOption({ label: 'SEE v1 (historical)' });
    await ben.locator('form[data-fork] [name=reason]').fill('Start over from the first observation after this trial closed.');
    await ben.getByRole('button', { name: 'Fork', exact: true }).click();
    await ben.waitForURL(url => url.href !== itemUrl && /\/items\/[^/]+$/.test(url.pathname));
    await ben.getByText('Forked from').first().waitFor();
    assert.equal(await ben.locator('.stage', { hasText: /^See$/ }).count(), 1);
    assert.equal(await ben.locator('form[data-approve], form[data-send], iframe').count(), 0);
    await leader.goto(itemUrl);
    assert.equal(await leader.locator('.stage', { hasText: 'Shelved' }).count(), 1, 'fork leaves terminal parent closed');
    step('phone member forked a terminal parent without reopening it or inheriting its authority');

    // Workspace memory exposes source records, never scores or authority.
    await olive.goto(`${origin}/items/new`);
    await olive.locator('[name=original]').fill('Transfer notes need a searchable handoff record.');
    await olive.getByRole('button', { name: 'Post SEE' }).click();
    await olive.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const memoryUrl = olive.url(), memoryId = memoryUrl.split('/').at(-1);
    await maya.goto(memoryUrl);
    await maya.locator('form[data-event=commented] [name=comment]').first().fill('quartz memory marker <img src=x onerror=alert(1)>');
    await maya.locator('form[data-event=commented]').first().getByRole('button', { name: 'Post comment' }).click();
    await maya.getByText('quartz memory marker').first().waitFor();
    await ben.goto(`${origin}/search?q=quartz`);
    await ben.getByRole('link', { name: 'commented by maya', exact: true }).click();
    await ben.getByRole('heading', { name: 'Work record', exact: true }).waitFor();
    const memoryHash = await ben.locator('form[data-event=credit_note] [name=source]').inputValue();
    await ben.locator('form[data-event=credit_note] [name=note]').fill('The searchable marker clarified the handoff detail.');
    const acknowledgement = ben.waitForResponse(response => response.url().endsWith(`/api/items/${memoryId}/events`) && response.request().method() === 'POST');
    await ben.getByRole('button', { name: 'Record acknowledgement' }).click();
    assert.equal((await acknowledgement).status(), 201);
    await ben.goto(`${origin}/people/maya`);
    await ben.getByRole('heading', { name: 'Contribution record: maya' }).waitFor();
    assert.match(await ben.locator('main').innerText(), /credited/);
    assert.equal(await rawPost(maya, `/api/items/${memoryId}/erase`, { body_hash: memoryHash }), 201);
    await ben.goto(`${origin}/search?q=quartz`);
    await ben.getByText('No matching records.', { exact: true }).waitFor();
    step('phone member found a source record, acknowledged its author, and erased text disappeared from search');

    // Optional mentoring remains separate from work records, even for a leader.
    for (const person of [olive, maya]) {
      await person.goto(`${origin}/mentoring`);
      await person.getByRole('button', { name: 'Opt in to mentoring', exact: true }).click();
      await person.getByRole('button', { name: 'Opt out and close active mentoring' }).waitFor();
    }
    await olive.goto(`${origin}/mentoring`);
    await olive.locator('[name=mentor]').selectOption('maya');
    await olive.locator('[name=objective]').fill('Practice a clearer private handoff.');
    await olive.getByRole('button', { name: 'Send mentoring request' }).click();
    await olive.waitForURL(/\/mentoring\/[^/]+$/);
    const mentoringUrl=olive.url();
    await maya.goto(mentoringUrl);
    await maya.getByRole('button', { name: 'Accept mentoring' }).click();
    await maya.getByLabel('Private check-in').waitFor();
    await olive.goto(mentoringUrl);
    await olive.getByLabel('Private check-in').fill('hazelnut private mentoring reflection.');
    await olive.getByRole('button', { name: 'Add private check-in' }).click();
    await olive.getByText('hazelnut private mentoring reflection.', { exact: false }).waitFor();
    assert.equal((await leader.goto(mentoringUrl)).status(),404,'leadership grants no private mentoring access');
    await leader.goto(`${origin}/search?q=hazelnut`);
    await leader.getByText('No matching records.', { exact: true }).waitFor();
    await olive.goto(mentoringUrl);
    await olive.locator('[name=text]').last().fill('One explicitly shared sponsor receipt.');
    await olive.locator('[name=scope]').selectOption('SPONSOR_SHARED');
    await olive.locator('[name=shared_with]').fill('leader');
    const receipt=olive.waitForResponse(response=>response.url().endsWith('/evidence')&&response.request().method()==='POST');
    await olive.getByRole('button', { name: 'Save evidence' }).click();
    assert.equal((await receipt).status(),201);
    const sharedLink=olive.getByRole('link',{name:'SPONSOR_SHARED evidence by olive',exact:true});
    await sharedLink.waitFor();
    const sharedId=(await sharedLink.getAttribute('href')).split('/').at(-1);
    const evidenceUrl=`${origin}/mentoring/evidence/${sharedId}`;
    assert.equal((await leader.goto(evidenceUrl)).status(),200);
    await leader.getByText('One explicitly shared sponsor receipt.',{exact:true}).waitFor();
    await olive.goto(evidenceUrl);
    await olive.getByRole('button',{name:'Revoke sharing'}).click();
    await olive.getByText(/Sharing revoked on/).waitFor();
    assert.equal((await leader.goto(evidenceUrl)).status(),404,'revoked sponsor evidence is unavailable');
    step('two people opted in; leader could not read private notes; explicit evidence share was revoked');

    // A person selects evidence and human criteria; the app makes no model call.
    await ben.goto(`${origin}/intelligence`);
    await ben.locator('[name=question]').fill('What handoff friction should we investigate?');
    await ben.locator('[name=objectives]').fill('Improve customer handoffs.');
    await ben.locator('[name=constraints]').fill('Preserve employee privacy.\nUse synthetic data for experiments.');
    await ben.locator('[name=items]').fill(`${itemId}\n${memoryId}`);
    const timeValue = time => new Date(time).toISOString().slice(0,19);
    await ben.locator('[name=from]').fill(timeValue(Date.now()-3600000));
    await ben.locator('[name=to]').fill(timeValue(Date.now()-1000));
    await ben.getByRole('button',{name:'Prepare evidence packet',exact:true}).click();
    await ben.locator('[data-analysis-export]:not([hidden])').waitFor();
    const analysisPacket = JSON.parse(await ben.locator('[data-analysis-prompt]').inputValue());
    assert.equal(analysisPacket.coverage.items.length,2);
    assert.doesNotMatch(JSON.stringify(analysisPacket),/hazelnut|quartz memory marker/);
    const answerFixture = structuredClone(analysisPacket.answer_contract);
    answerFixture.findings[0].claim='Synthetic answer fixture <img src=x onerror=alert(1)>.';
    await ben.locator('[name=answer]').fill(JSON.stringify(answerFixture));
    await ben.getByRole('button',{name:'Check citations and review answer',exact:true}).click();
    await ben.locator('[data-analysis-answer]:not([hidden])').waitFor();
    assert.match(await ben.locator('[data-analysis-answer]').innerText(),/Unverified model text/);
    assert.equal(await ben.locator('[data-analysis-answer] img').count(),0);
    assert.ok(await ben.locator('[data-analysis-answer] a[href*="/record/"]').count()>0);
    answerFixture.findings[0].citations[0].hash='f'.repeat(64);
    await ben.locator('[name=answer]').fill(JSON.stringify(answerFixture));
    await ben.getByRole('button',{name:'Check citations and review answer',exact:true}).click();
    await ben.locator('[data-analysis-review] [role=alert]').waitFor();
    step('phone member prepared cross-workstream evidence, private/erased content stayed out, cited model fixture rendered inert, fake citation refused');

    assert.deepEqual(problems, [], `browser problems:\n${problems.join('\n')}`);
    console.log('PASS: Vision journey in a real browser: SEE, Effort, mention, include and credit, SPEC IT!, SEND IT!, decision, fork, adopted steer, reassign, mention cap, Vision Quest.');
  } finally {
    await browser.close();
    for (const child of children) child.kill('SIGTERM');
  }
}
