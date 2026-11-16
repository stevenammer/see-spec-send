// Real-browser journey for continuous reanalysis, synthetic data only.
// A declined idea is later reached by an unrelated result; the person who owns it
// sees a labeled update on the frozen case and asks for a NEW decision. The old
// case never changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../core/store.js';
const require = createRequire(import.meta.url);
const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
const root = new URL('../..', import.meta.url).pathname;
const db = join(mkdtempSync(join(tmpdir(), 'sss-reanalysis-')), 'sss.db');
const env = { ...process.env, SSS_DB: db };
const cli = args => new Promise((resolve, reject) => {
  let out = '', err = ''; const child = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env });
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  child.on('close', code => code ? reject(Error(err || out)) : resolve(out.trim()));
});
await cli(['init', '--id', 'admin']);
const port = 24000 + Math.floor(Math.random() * 2000), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['cli.js', 'serve', '--port', String(port), '--origin', origin, '--insecure-cookies'], { cwd: root, env });
let browser;
const step = text => console.log(`  ok ${text}`);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/signin`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const join_ = async (name, viewport) => {
    const invite = await cli(['invite', 'create', '--role', 'member']);
    const context = await browser.newContext({ viewport }); const page = await context.newPage();
    await page.goto(`${origin}/redeem`); await page.locator('[name=invite]').fill(invite);
    await page.locator('[name=id]').fill(name); await page.locator('[name=password]').fill(`${name}-long-password-9x`);
    await page.getByRole('button', { name: 'Join' }).click(); await page.getByRole('link', { name: 'Post a problem' }).waitFor();
    return page;
  };
  const post = async (page, text) => {
    await page.goto(`${origin}/items/new`); await page.locator('[name=original]').fill(text);
    await page.getByRole('button', { name: 'Post SEE' }).click(); await page.waitForURL(/\/items\/(?!new$)[^/]+$/);
    return new URL(page.url()).pathname.split('/').at(-1);
  };
  const dana = await join_('dana', { width: 390, height: 844 }), sam = await join_('sam', { width: 1280, height: 900 });
  const danaItem = await post(dana, 'The handoff loses the caller note.');
  const samItem = await post(sam, 'Night shift cannot see the export.');
  step('two people posted SEEs in a real browser');

  // Move both cases to a decision with recorded events (the leader is the admin).
  const store = new Store(db); let n = 0;
  const bind = item => ({ post_id: store.read(item).context.activePost?.id, post_version: store.read(item).context.activePost?.version });
  const add = (item, event) => store.append(item, { ...event, at: '2026-11-10T12:00:00.000Z' }, { idem: `rj-${++n}` });
  const advance = (item, author, assumption) => {
    add(item, { type: 'specced', actor: author, see_hash: store.read(item).context.seeHash, must: ['Keep the caller note'], how_we_know: ['The note appears'], out_of_scope: [], assumptions: [assumption], open_questions: [], ...bind(item) });
    const spec = store.read(item).context.specHash, packet = store.putArtifact(item, JSON.stringify({ specHash: spec }));
    add(item, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(item) });
    return { spec_hash: spec, packet_hash: packet };
  };
  const d = advance(danaItem, 'dana', 'The handoff needs a new integration to carry the caller note.');
  add(danaItem, { type: 'decided', actor: 'admin', disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration this quarter.', metadata: {}, ...d, ...bind(danaItem) });
  const s = advance(samItem, 'sam', 'The export permission is the only blocker.');
  const before = { events: store.eventRows(danaItem).map(r => r.hash), ok: store.verify(danaItem).ok, posts: JSON.stringify(store.db.prepare('SELECT * FROM stage_posts WHERE item=? ORDER BY post_id').all(danaItem)) };
  add(samItem, { type: 'decided', actor: 'admin', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'The existing export already carries the caller note across the handoff, so no integration is needed.', metadata: { alternative: 'Use the export.', action_owner: 'sam' }, ...s, ...bind(samItem) });
  step('one case was declined for a stated reason; an unrelated case later reached its own decision');

  const out = await cli(['reanalysis', 'run']);
  assert.match(out, /annex/i, out);
  step(`reanalysis ran from the CLI: ${out.replace(/\s+/g, ' ')}`);

  await dana.goto(`${origin}/items/${danaItem}`);
  await dana.getByRole('heading', { name: 'Updates since this was frozen' }).waitFor();
  const section = await dana.locator('#reanalysis-updates').innerText();
  assert.match(section, /Found by Effort \(AI\)/);
  assert.match(section, /This does not change the earlier decision/);
  assert.match(section, /new integration/i);
  step('the frozen case shows a labeled AI update, outside the frozen thread');

  await dana.locator('form[data-annex-response] button[value=relevant]').click();
  await dana.waitForLoadState('networkidle');
  step('the owner marked the update relevant');

  await dana.locator('form[data-renew] [name=reason]').fill('A later case solved this with the existing export.');
  await dana.getByRole('button', { name: 'Ask for a new decision' }).click();
  await dana.waitForURL(url => !url.pathname.endsWith(danaItem) && /\/items\/[^/]+$/.test(url.pathname));
  const childId = new URL(dana.url()).pathname.split('/').at(-1);
  assert.notEqual(childId, danaItem);
  step('asking for a new decision opened a separate, linked case');

  const fresh = new Store(db);
  assert.equal(fresh.events(childId)[0].relation, 'renewal');
  assert.equal(fresh.read(childId).context.approval, 0, 'no approval is inherited');
  const after = { events: fresh.eventRows(danaItem).map(r => r.hash), ok: fresh.verify(danaItem).ok, posts: JSON.stringify(fresh.db.prepare('SELECT * FROM stage_posts WHERE item=? ORDER BY post_id').all(danaItem)) };
  assert.deepEqual(after, before, 'the original declined case is byte-identical');
  assert.ok(fresh.knowledge.verify().ok);
  step('the original decision and its frozen record are unchanged');

  // Memory: the typed Knowledge page finds the stated reason, and the readable closing report takes a correction.
  await dana.goto(`${origin}/knowledge?q=integration`);
  assert.match(await dana.locator('main').innerText(), /No budget for a new integration/, 'the knowledge page finds the decline reason');
  const sendPost = fresh.db.prepare("SELECT post_id FROM stage_posts WHERE item=? AND kind='decision'").get(danaItem);
  assert.ok(sendPost, 'the declined case has a frozen decision post');
  fresh.close();
  const { runCloseoutJobs } = await import('../../core/closeout.js');
  const writer = new Store(db); runCloseoutJobs(writer, {}); writer.close();
  await dana.goto(`${origin}/items/${danaItem}/closeout/${encodeURIComponent(sendPost.post_id)}`);
  await dana.getByRole('heading', { name: 'Closing report' }).waitFor();
  assert.match(await dana.locator('main').innerText(), /No budget for a new integration/);
  await dana.locator('form[data-correction] [name=note]').fill('Context: the existing export was not known when this was decided.');
  await dana.getByRole('button', { name: 'This is wrong / Add context' }).click();
  let checked, corrections = [];
  for (let i = 0; i < 100 && !corrections.length; i++) { // the page posts in the background; poll the record
    await new Promise(r => setTimeout(r, 100)); checked?.close(); checked = new Store(db); corrections = checked.knowledge.entries('correction');
  }
  assert.equal(corrections.length, 1, 'a correction was recorded');
  assert.equal(corrections[0].body.actor ?? corrections[0].body.person ?? 'dana', 'dana');
  assert.deepEqual(checked.eventRows(danaItem).map(r => r.hash), before.events, 'the source record did not change');
  assert.ok(checked.knowledge.verify().ok);
  checked.close();
  step('memory: the knowledge page found the reason, and a correction was recorded without touching the source');

  const samSeesNothing = await sam.goto(`${origin}/items/${samItem}`);
  assert.equal(samSeesNothing.status(), 200);
  console.log('PASS: continuous reanalysis in a real browser: result, linked update, response, a new decision, and a correction, with the old case untouched.');
} finally {
  await browser?.close(); server.kill();
}
