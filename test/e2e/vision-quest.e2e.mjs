// Real local browser path, no models or external requests. Not in the default test glob.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../../core/store.js';
import { Auth } from '../../app/auth.js';
import { createHandler } from '../../app/http.js';
import { STEPS } from '../../public/vision-quest.js';
import { sealQuest } from '../../public/quest-storage.js';
import { randomUUID } from 'node:crypto';
import { completedQuest } from '../helpers/quest-fixture.mjs';

const require = createRequire(import.meta.url);
const directory = process.env.PLAYWRIGHT_DIR;
const { chromium } = directory ? require(directory) : require('playwright');
const temp = mkdtempSync(join(tmpdir(), 'sss-quest-browser-'));
const store = new Store(join(temp, 'quest.db'));
const auth = new Auth(store);
const password = 'fictional-browser-passphrase-9';
await auth.createUser('maker', password, false);
let handler;
const server = createServer((req, res) => handler(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
handler = createHandler({ auth, store, secure: false, origin });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ||
  '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) errors.push('Unexpected external request.');
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin);
  await page.locator('[name=id]').fill('maker');
  await page.locator('[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Start a Vision Quest' }).click();
  const answer = () => page.locator('#quest-content > form [name=answer]');
  await answer().fill('The queue repeated a request. Immediate recovery matters.');
  await page.reload();
  await answer().waitFor();
  assert.equal(await answer().inputValue(),
    'The queue repeated a request. Immediate recovery matters.');
  assert.match(await page.locator('#quest-status').innerText(), /Unsent input recovered/);
  assert.equal(store.listItems().length, 0);
  const fixture = completedQuest({ setting: 'works',
    problem: 'A bad field asks us for the same value twice', impact: '1', repeat: '2', control: '4', evidence: '4' });
  for (const step of STEPS) {
    const turn = fixture.turns.find(turn => turn.step === step.key);
    if (step.options) await answer().selectOption(turn.value);
    else await answer().fill(turn.value);
    const note = page.locator('#quest-content > form [name=note]');
    if (await note.count()) await note.fill(turn.note);
    await page.locator('#quest-content > form').getByRole('button', {
      name: 'Save answer and continue', exact: true,
    }).click();
    await page.waitForFunction(key => {
      const form = document.querySelector('#quest-content > form [name=answer]');
      const heading = document.querySelector('#quest-content h2');
      return heading?.textContent === 'Review your memo' ||
        form?.closest('form')?.dataset.questStep !== key;
    }, step.key);
  }
  await page.getByRole('heading', { name: 'Review your memo', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'CONFIGURE', exact: true }).count(), 1);
  assert.equal(store.listItems().length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByText('Review or correct an earlier answer', { exact: true }).click();
  const correction = page.locator('#quest-content details');
  await correction.locator('label > select').first().selectOption('problem');
  const corrected = 'A corrected bad field asks for the duplicate value';
  await correction.locator('[name=answer]').fill(corrected);
  await page.reload();
  await page.locator('#quest-content details[open]').waitFor();
  assert.equal(await page.locator('#quest-content details [name=answer]').inputValue(), corrected);
  assert.equal(await page.getByRole('button', { name: 'Post my checked problem' }).count(), 0);
  await page.locator('#quest-content details').getByRole('button', {
    name: 'Save answer and continue',
  }).click();
  await page.locator('#quest-content > form [name=answer]').selectOption('yes');
  await page.locator('#quest-content > form').getByRole('button', {
    name: 'Save answer and continue',
  }).click();
  await page.getByRole('heading', { name: 'Review your memo', exact: true }).waitFor();
  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export draft', exact: true }).click();
  const download = await downloadWait;
  const exportPath = join(temp, 'export.json');
  await download.saveAs(exportPath);
  await page.locator('#quest-restore').setInputFiles(exportPath);
  await page.getByRole('heading', { name: 'Review your memo', exact: true }).waitFor();
  assert.equal(store.listItems().length, 0);
  await page.locator('[name=reviewed]').check();
  await page.getByRole('button', { name: 'Post my checked problem', exact: true }).click();
  await page.waitForURL(/\/items\//);
  assert.equal(store.listItems().length, 1);
  assert.match(await page.locator('main').innerText(), /No build is proposed/);
  assert.equal(store.events(store.listItems()[0].id).length, 1);
  assert.equal(store.events(store.listItems()[0].id)[0].problem, corrected);
  await page.goto(`${origin}/quest`);
  await page.getByRole('heading', { name: 'This quest was posted' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Post my checked problem' }).count(), 0);
  await page.getByRole('button', { name: 'Start another quest', exact: true }).click();
  await answer().waitFor();
  await page.getByRole('button', { name: 'Export earlier quest 1', exact: true }).waitFor();
  // This imported fixture represents another quest with its own lifecycle identity.
  const oldExport = JSON.parse((await import('node:fs')).readFileSync(exportPath, 'utf8')).data;
  writeFileSync(exportPath, await sealQuest({ ...oldExport, questId: randomUUID() }));
  // A corrupt active pointer remains recoverable through an explicitly approved import.
  await page.evaluate(() => localStorage.setItem('sss-quest:maker', 'corrupt-head'));
  await page.reload();
  await page.getByText(/saved draft head is invalid/).waitFor();
  await page.locator('#quest-restore').setInputFiles(exportPath);
  await page.getByRole('heading', { name: 'Review your memo', exact: true }).waitFor();
  assert.equal(store.listItems().length, 1);
  await page.getByText('Review or correct an earlier answer', { exact: true }).click();
  await page.locator('#quest-content details label > select').first().selectOption('problem');
  await page.locator('#quest-content details [name=answer]').fill('Older unsent from tab A');
  const other = await context.newPage();
  await other.goto(`${origin}/quest`);
  await other.getByText('Review or correct an earlier answer', { exact: true }).click();
  await other.locator('#quest-content details label > select').first().selectOption('problem');
  await other.locator('#quest-content details [name=answer]').fill('Newer submitted from tab B');
  await other.locator('#quest-content details').getByRole('button', {
    name: 'Save answer and continue',
  }).click();
  await other.locator('#quest-content > form [name=answer]').selectOption('yes');
  await other.locator('#quest-content > form').getByRole('button', {
    name: 'Save answer and continue',
  }).click();
  await other.getByRole('heading', { name: 'Review your memo', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Export my older unsent recovery' }).waitFor();
  assert.match(await page.locator('#quest-content').innerText(), /Newer submitted from tab B/);
  assert.match(await page.locator('#quest').innerText(), /Older unsent from tab A/);
  const oldDownloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my older unsent recovery' }).click();
  const oldPath = join(temp, 'older.json');
  await (await oldDownloadWait).saveAs(oldPath);
  const { readFileSync } = await import('node:fs');
  assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).data.pending.value,
    'Older unsent from tab A');
  await page.getByText('Review or correct an earlier answer', { exact: true }).click();
  await page.locator('#quest-content details label > select').first().selectOption('problem');
  await page.locator('#quest-content details [name=answer]').fill('Another current unsent correction');
  await page.reload();
  await page.getByRole('button', { name: 'Export my older unsent recovery' }).waitFor();
  assert.equal(await page.locator('#quest-content details [name=answer]').inputValue(),
    'Another current unsent correction');
  assert.match(await page.locator('#quest').innerText(), /Older unsent from tab A/);
  const currentDownloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export draft', exact: true }).click();
  const currentPath = join(temp, 'current.json');
  await (await currentDownloadWait).saveAs(currentPath);
  const current = JSON.parse(readFileSync(currentPath, 'utf8')).data;
  assert.equal(current.pending.value, 'Another current unsent correction');
  assert.equal(current.turns.filter(turn => turn.step === 'problem').at(-1).value,
    'Newer submitted from tab B');
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('sss-quest:')) throw Error('Simulated quota failure');
      return window.originalSetItem.call(this, key, value);
    };
  });
  await page.locator('#quest-content details [name=answer]').fill('Keep this unsaved correction visible');
  await page.locator('#quest-content details').getByRole('button', {
    name: 'Save answer and continue',
  }).click();
  assert.match(await page.locator('#quest-status').innerText(), /Not saved/);
  assert.match(await page.locator('#quest-error').innerText(), /quota failure/);
  assert.equal(await page.locator('#quest-content details [name=answer]').inputValue(),
    'Keep this unsaved correction visible');
  assert.equal(store.listItems().length, 1);
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
  await page.getByRole('button', { name: 'Start another quest', exact: true }).click();
  await answer().waitFor();
  const restoreFixture = async overrides => {
    const path = join(temp, 'fixture.json');
    const quest = { ...completedQuest(overrides), questId: randomUUID() };
    writeFileSync(path, await sealQuest(quest));
    await page.locator('#quest-restore').setInputFiles(path);
    await page.getByRole('heading', { name: 'Review your memo', exact: true }).waitFor();
    return quest;
  };
  await restoreFixture({ first_test: 'Try one bounded change', better: 'Fewer retries',
    out_scope: 'A larger rollout', chair: 'RAW BROWSER CHAIR', depends: 'RAW BROWSER DEPENDENCY' });
  const beforePost = await page.evaluate(() => localStorage.getItem('sss-quest:maker'));
  let attempts = 0;
  await page.route('**/api/items', async route => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    else await route.continue();
  });
  await page.locator('[name=reviewed]').check();
  await page.getByRole('button', { name: 'Post my checked problem', exact: true }).click();
  await page.getByText(/proposal was refused/).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sss-quest:maker')), beforePost);
  assert.equal(await page.getByRole('heading', { name: 'BUILD', exact: true }).count(), 1);
  await page.evaluate(() => {
    const form = document.querySelector('[name=reviewed]').form;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    window.questWasInert = document.getElementById('quest').inert;
  });
  await page.waitForURL(/\/items\//);
  assert.equal(await page.locator('[name=must]').inputValue(), 'Try one bounded change');
  assert.equal(await page.locator('[name=how_we_know]').inputValue(), 'Fewer retries');
  assert.equal(await page.locator('[name=out_of_scope]').inputValue(), 'A larger rollout');
  assert.equal(attempts, 2);
  const buildId = new URL(page.url()).pathname.split('/').at(-1);
  assert.equal(store.events(buildId).length, 1);
  assert.equal(store.read(buildId).state, 'CHECKED');
  assert.doesNotMatch(store.exportJsonl(), /RAW BROWSER CHAIR|RAW BROWSER DEPENDENCY|"turns"/);
  const returned = await page.evaluate(async id => (await fetch(`/api/items/${id}`)).text(), buildId);
  assert.doesNotMatch(returned, /RAW BROWSER CHAIR|RAW BROWSER DEPENDENCY|"turns"/);
  await page.unroute('**/api/items');
  await page.goto(`${origin}/quest`);
  await page.getByRole('heading', { name: 'This quest was posted' }).waitFor();
  await page.getByRole('button', { name: 'Start another quest', exact: true }).click();
  await answer().waitFor();
  await restoreFixture({ approach: 'process' });
  await page.getByRole('heading', { name: 'PROCESS CHANGE', exact: true }).waitFor();
  await page.getByText(/Posting files this as a setting/).waitFor();
  await page.locator('[name=reviewed]').check();
  await page.getByRole('button', { name: 'Post my checked problem', exact: true }).click();
  await page.waitForURL(/\/items\//);
  const processId = new URL(page.url()).pathname.split('/').at(-1);
  assert.equal(store.events(processId)[0].verdict, 'setting');
  assert.match(await page.locator('main').innerText(), /PROCESS CHANGE/);
  assert.equal(await page.locator('[data-event=specced]').count(), 0);
  await page.goto(`${origin}/quest`);
  await page.getByRole('button', { name: 'Start another quest', exact: true }).click();
  await answer().waitFor();
  await answer().fill('A har\u200bass\u200dment report');
  await page.getByRole('button', { name: 'Save answer and continue', exact: true }).click();
  await page.getByRole('heading', { name: 'This needs a human', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start another quest', exact: true }).click();
  await answer().waitFor();
  assert.equal(await answer().inputValue(), '');
  assert.ok(await page.getByRole('button', { name: /^Export earlier quest/ }).count() >= 4);
  assert.deepEqual(errors, []);
  console.log('PASS 320px guided configure path, immediate reload and correction recovery, ' +
    'verified export/restore, corrupt-head and durable two-tab recovery, visible quota failure, ' +
    'explicit single checked event, weak-signal configure, BUILD prefill, PROCESS CHANGE, retry and lifecycle, memo privacy, no models.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
  rmSync(temp, { recursive: true, force: true });
}
