// Separate-origin proof. Run outside a restricted sandbox:
// PLAYWRIGHT_DIR=/path/to/node_modules npm run test:bundle-origin
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from '../../core/store.js';
import { Auth } from '../../app/auth.js';
import { createServerFor } from '../../app/http.js';
import { createBundleServer } from '../../app/bundle-origin.js';
import { fixture } from '../helpers/gateway-fixture.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const bundle = files => JSON.stringify({ sss_bundle: 1, manifest: { version: 1, files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: digest(text) })) }, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')])) });

async function main() {
  const require = createRequire(import.meta.url); const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
  const f = fixture(); const { store, run } = f; const auth = new Auth(store); const password = 'correct-horse-9-battery';
  await auth.createUser('writer', password); await auth.createUser('leader', password, true);
  const source = bundle({
    'index.html': '<!doctype html><link rel="stylesheet" href="style.css"><textarea id="note"></textarea><pre id="out"></pre><script src="app.js"></script>',
    'style.css': '#note{background:rgb(1, 2, 3)}',
    'app.js': `const n=document.querySelector('#note');n.value=localStorage.note||'';n.oninput=()=>localStorage.note=n.value;Promise.all([fetch('http://127.0.0.1:23081/api/items'),fetch('https://example.invalid/')]).then(()=>document.querySelector('#out').textContent='BAD').catch(()=>document.querySelector('#out').textContent=JSON.stringify({cookie:document.cookie,app:'blocked',external:'blocked',top:(()=>{try{return top.document.title}catch(e){return 'blocked'}})()}));`,
  });
  const artifactHash = store.putArtifact('item', source);
  store.append('item', { type: 'tried', actor: run.run_actor, approval: run.approval, spec_hash: run.spec_hash, iteration: 0, artifact_hash: artifactHash, model_output: true, at: new Date().toISOString() }, { idem: 'bundle-e2e' });
  const appPort = 23081, bundlePort = 23082, appOrigin = `http://127.0.0.1:${appPort}`;
  const bundleServer = createBundleServer({ store, secret: randomBytes(32), hostSuffix: 'localhost', appOrigin });
  const app = createServerFor({ store, auth, secure: false, origin: appOrigin, bundleServer });
  await new Promise(resolve => bundleServer.listen(bundlePort, '127.0.0.1', resolve)); await new Promise(resolve => app.listen(appPort, '127.0.0.1', resolve));
  const login = await fetch(`${appOrigin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'writer', password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext(); await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: appOrigin }]);
    const page = await context.newPage(); await page.goto(`${appOrigin}/items/item`);
    const iframe = await page.locator('iframe[title="Playable try"]').elementHandle(); const frame = await iframe.contentFrame();
    await frame.locator('#out').waitFor(); await frame.waitForFunction(() => document.querySelector('#out').textContent.startsWith('{'));
    assert.equal(await frame.locator('#note').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(1, 2, 3)');
    assert.notEqual(new URL(frame.url()).origin, appOrigin); const result = JSON.parse(await frame.locator('#out').textContent());
    assert.equal(result.cookie, ''); assert.deepEqual({ app: result.app, external: result.external, top: result.top }, { app: 'blocked', external: 'blocked', top: 'blocked' });
    await frame.locator('#note').fill('persists'); await page.reload(); const refreshed = await (await (await page.locator('iframe[title="Playable try"]').elementHandle()).contentFrame()).locator('#note'); await assert.equal(await refreshed.inputValue(), 'persists');
  } finally { await browser.close(); await new Promise(resolve => app.close(resolve)); await new Promise(resolve => bundleServer.close(resolve)); store.close(); }
}

if (!process.env.NODE_TEST_CONTEXT) { await main(); console.log('PASS: bundle origin in a real browser: the build ran with its script and styles, kept its own storage, and could not reach the app.'); }
