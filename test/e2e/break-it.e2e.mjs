// Browser proof of what happens when people use the app carelessly: refused pages, double clicks, blank posts,
// signing out, wrong passwords, and the administration buttons. Each of these was a real finding.
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
  const db = join(mkdtempSync(join(tmpdir(), 'sss-break-')), 'sss.db');
  const env = { ...process.env, SSS_DB: db };
  const port = 25000 + Math.floor(Math.random() * 1000), origin = `http://127.0.0.1:${port}`;
  const cli = args => new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env });
    child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    child.on('close', code => code ? reject(Error(err || out)) : resolve(out.trim()));
  });
  const init = await cli(['init', '--id', 'leader']);
  const temporary = init.match(/one-time password: (\S+)/)[1];
  const invite = await cli(['invite', 'create', '--role', 'member']);
  const server = spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies'], { cwd: root, env });
  let browser;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/signin`)).ok) break; } catch {} await pause(100); }
    browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const native = [];
    const watch = page => { page.on('dialog', dialog => { native.push(dialog.type()); dialog.dismiss(); }); return page; };
    const mayaContext = await browser.newContext();
    const guest = watch(await browser.newPage()), leader = watch(await browser.newPage()), maya = watch(await mayaContext.newPage());

    // A signed-out visitor who opens a private page is sent to sign in, not shown JSON.
    for (const path of ['/items/new', '/search', '/items/anything']) {
      await guest.goto(origin + path);
      assert.equal(new URL(guest.url()).pathname, '/signin', path);
      assert.match(await guest.locator('main').innerText(), /way for a team to fix the problems/);
    }

    // Join, and see the sign-out button.
    await maya.goto(`${origin}/redeem`); await maya.locator('[name=invite]').fill(invite); await maya.locator('[name=id]').fill('maya');
    await maya.locator('[name=password]').fill('maya-long-password-9x'); await maya.getByRole('button', { name: 'Join' }).click();
    await maya.getByRole('link', { name: 'Post a problem' }).waitFor();

    // A blank post cannot be sent. Spaces only is refused with a plain message.
    await maya.goto(`${origin}/items/new`); await maya.locator('[name=original]').fill('    \n  ');
    await maya.getByRole('button', { name: 'Post SEE' }).click();
    await maya.locator('[role=alert]').waitFor();
    assert.match(await maya.locator('[role=alert]').innerText(), /Write something in the box first/);
    assert.equal(new URL(maya.url()).pathname, '/items/new');

    // A double click posts once, not twice.
    await maya.locator('[name=original]').fill('Double click test problem.');
    await maya.getByRole('button', { name: 'Post SEE' }).dblclick();
    await maya.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const itemUrl = maya.url();
    await maya.goto(origin + '/');
    assert.equal((await maya.locator('main').innerText()).split('Double click test problem.').length - 1, 1, 'one item, not two');

    // A long unbroken string does not push the page off a phone screen.
    await maya.setViewportSize({ width: 390, height: 844 });
    await maya.goto(`${origin}/items/new`); await maya.locator('[name=original]').fill('x'.repeat(300) + ' https://example.com/' + 'a'.repeat(200));
    await maya.getByRole('button', { name: 'Post SEE' }).click(); await maya.waitForURL(/\/items\/(?!new$)[^/]+$/);
    const width = await maya.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(width[0] <= width[1] + 1, `no sideways scroll on a phone: ${width}`);

    // A page that is not there, or not theirs, is a page that says so.
    for (const path of ['/items/zzz', '/items/zzz/spec', `${new URL(itemUrl).pathname}/record/nothing`, '/nonexistent']) {
      await maya.goto(origin + path);
      assert.match(await maya.locator('main').innerText(), /That page isn't available/, path);
    }

    // A pasted box over its limit says what was cut. The count shows near the limit.
    await maya.goto(`${origin}/items/new`);
    await maya.locator('[name=original]').evaluate(el => { el.value = 'y'.repeat(3300); el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.match(await maya.locator('.limit-note').innerText(), /3,300 of 4,000 characters/);

    // Signing out ends the session. A comment typed after another tab signed out says why, and keeps the text.
    const other = watch(await mayaContext.newPage()); await other.goto(origin + '/');
    await maya.goto(itemUrl);
    await maya.locator('form[data-event=commented] textarea').first().fill('A long comment I do not want to lose.');
    await other.getByRole('button', { name: 'Sign out' }).click(); await other.waitForURL(/\/signin/);
    await maya.locator('form[data-event=commented] button').first().click();
    await maya.locator('[role=alert]').first().waitFor();
    assert.match(await maya.locator('[role=alert]').first().innerText(), /signed out/);
    assert.equal(await maya.locator('form[data-event=commented] textarea').first().inputValue(), 'A long comment I do not want to lose.');

    // A wrong password gets help, not a dead end; the right one works once the short wait passes.
    await maya.goto(`${origin}/signin`); await maya.locator('[name=id]').fill('maya'); await maya.locator('[name=password]').fill('not-the-password-1');
    await maya.getByRole('button', { name: 'Sign in' }).click();
    assert.match(await maya.locator('[role=alert]').innerText(), /didn't work.*wait about 10 seconds/);
    await pause(2600);
    await maya.locator('[name=password]').fill('maya-long-password-9x'); await maya.getByRole('button', { name: 'Sign in' }).click();
    await maya.getByRole('link', { name: 'Post a problem' }).waitFor();

    // Administration: a leader's Promote and Disable buttons work, with a masked password box and no native pop-up.
    await leader.goto(`${origin}/signin`); await leader.locator('[name=id]').fill('leader'); await leader.locator('[name=password]').fill(temporary);
    await leader.getByRole('button', { name: 'Sign in' }).click();
    await leader.locator('[name=current]').fill(temporary); await leader.locator('form[data-password] [name=password]').fill('leader-chosen-password-9x');
    await leader.getByRole('button', { name: 'Change password' }).click(); await leader.getByRole('link', { name: 'Post a problem' }).waitFor();
    await leader.goto(origin + '/admin');
    const row = leader.locator('form[data-admin=person]').filter({ has: leader.locator('[value=maya]') });
    const ask = async answer => {
      await row.getByRole('button', { name: /^(Disable|Enable)$/ }).click();
      const dialog = leader.locator('dialog[open]'); await dialog.waitFor();
      assert.equal(await dialog.locator('input').getAttribute('type'), 'password', 'the password is masked');
      if (answer === null) { await dialog.getByRole('button', { name: 'Cancel' }).click(); return; }
      await dialog.locator('input').fill(answer); await dialog.getByRole('button', { name: 'Confirm' }).click();
    };
    await ask(null); await row.locator('[role=alert]').waitFor();
    assert.match(await row.locator('[role=alert]').innerText(), /Nothing was changed/);
    await ask('wrong-password-here'); await leader.waitForFunction(() => /didn't work, so nothing was changed/.test(document.body.innerText));
    assert.equal(await row.getByRole('button', { name: 'Disable' }).isEnabled(), true, 'the buttons come back after a refusal');
    await ask('leader-chosen-password-9x'); await row.getByRole('button', { name: 'Enable' }).waitFor();
    await row.getByRole('button', { name: 'Promote' }).click();
    await leader.locator('dialog[open]').waitFor(); await leader.locator('dialog[open] input').fill('leader-chosen-password-9x'); await leader.locator('dialog[open]').getByRole('button', { name: 'Confirm' }).click();
    await row.getByRole('button', { name: 'Demote' }).waitFor();
    assert.deepEqual(native, [], 'no native browser pop-up was used');
    process.stdout.write('PASS break-it browser journey\n');
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
}
