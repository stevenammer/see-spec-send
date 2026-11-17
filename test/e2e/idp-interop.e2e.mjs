// Interoperability against an independent, certified OIDC implementation (node-oidc-provider), real browser, loopback only.
// Not a dependency of this repo: set OIDC_PROVIDER_DIR to a folder where `npm i oidc-provider` was run. Skips loudly without it.
// Proves: discovery, PKCE S256, nonce, RS256 verification against the provider's real JWKS, the `iss` callback parameter,
// and single sign-on step-up (prompt=login forces a new login and the provider reports a fresh auth_time).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
if (!process.env.OIDC_PROVIDER_DIR) { console.log('SKIP: set OIDC_PROVIDER_DIR (a folder with oidc-provider installed) to run the real-provider interop test'); process.exit(0); }
const playwright = require(join(process.env.PLAYWRIGHT_DIR || '', 'playwright'));
const { default: Provider } = await import(require.resolve('oidc-provider', { paths: [process.env.OIDC_PROVIDER_DIR] }));
const root = new URL('../..', import.meta.url).pathname, dir = mkdtempSync(join(tmpdir(), 'sss-idp-'));
const idpPort = 25000 + Math.floor(Math.random() * 1000), appPort = 26000 + Math.floor(Math.random() * 1000);
const idp = `http://127.0.0.1:${idpPort}`, app = `http://127.0.0.1:${appPort}`;
const provider = new Provider(idp, {
  clients: [{ client_id: 'sss-interop', client_secret: 'interop-secret-not-real', redirect_uris: [`${app}/api/oidc/callback`], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_post', require_auth_time: true }],
  pkce: { required: () => true }, scopes: ['openid', 'email'],
  claims: { openid: ['sub'], email: ['email', 'email_verified'] },
  conformIdTokenClaims: false,   // put scope claims in the ID token: our email-domain rule reads them there
  features: { devInteractions: { enabled: true } },
  findAccount: async (ctx, id) => ({ accountId: id, claims: async () => ({ sub: id, email: `${id}@example.test`, email_verified: true }) }),
  cookies: { keys: ['interop-cookie-key-not-real'] },
});
const idpServer = createServer(provider.callback()).listen(idpPort, '127.0.0.1');
writeFileSync(join(dir, 'oidc.json'), JSON.stringify({ issuer: idp, clientId: 'sss-interop', clientSecretEnv: 'SSS_OIDC_CLIENT_SECRET', redirectUri: `${app}/api/oidc/callback`, hosts: ['127.0.0.1'], allowedEmailDomains: ['example.test'], autoProvision: true, allowInsecureLoopbackForDevelopment: true }));
const env = { ...process.env, SSS_DB: join(dir, 'sss.db'), SSS_OIDC_CLIENT_SECRET: 'interop-secret-not-real' };
const run = args => new Promise((res, rej) => { let o = ''; const c = spawn(process.execPath, ['cli.js', ...args], { cwd: root, env }); c.stdout.on('data', b => o += b); c.stderr.on('data', b => o += b); c.on('close', code => code ? rej(Error(o)) : res(o)); });
await run(['init', '--id', 'admin']);
const server = spawn(process.execPath, ['cli.js', 'serve', '--port', String(appPort), '--origin', app, '--insecure-cookies', '--oidc-config', join(dir, 'oidc.json'), '--disable-password-login'], { cwd: root, env });
let log = ''; server.stderr.on('data', b => log += b); server.stdout.on('data', b => log += b);
let browser; const step = t => console.log(`  ok ${t}`);
const login = async (page, who) => {
  await page.locator('input[name=login]').fill(who); await page.locator('input[name=password]').fill('any-dev-password');
  await page.getByRole('button', { name: /sign-in|sign in|continue/i }).first().click();
  const consent = page.getByRole('button', { name: /continue/i }); if (await consent.isVisible({ timeout: 2000 }).catch(() => false)) await consent.click();
};
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${app}/signin`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${app}/api/oidc/start`);
  await page.locator('input[name=login]').waitFor({ timeout: 10000 });
  await login(page, 'interop-person'); await page.waitForURL(`${app}/**`, { timeout: 15000 });
  assert.ok(!page.url().includes('/api/oidc/callback'), 'callback finished and redirected');
  step('real provider: discovery, PKCE, nonce, RS256 signature and the iss parameter all accepted');
  const db = new DatabaseSync(env.SSS_DB, { readOnly: true });
  const row = () => db.prepare("SELECT auth_method, stepup, stepup_used FROM sessions ORDER BY created DESC LIMIT 1").get();
  assert.equal(row().auth_method, 'oidc'); assert.ok(!row().stepup, 'no step-up yet');
  await page.goto(`${app}/api/oidc/stepup/start?next=%2Fitems%2Fdoesnotexist`);
  await page.locator('input[name=login]').waitFor({ timeout: 10000 });   // prompt=login: the provider must ask again even though we have a provider session
  step('real provider honored prompt=login: asked for the sign-in again');
  await login(page, 'interop-person'); await page.waitForURL(`${app}/items/doesnotexist`, { timeout: 15000 });
  assert.ok(row().stepup > 0 && row().stepup_used === 0, 'a fresh single-use step-up was recorded');
  step('step-up returned to the item with auth_time accepted and one unused proof recorded');
  // A different person answering the step-up is refused.
  await page.goto(`${app}/api/oidc/stepup/start?next=%2Fitems%2Fx`); await page.locator('input[name=login]').waitFor();
  const before = row().stepup; await login(page, 'someone-else');
  await page.waitForTimeout(1500); assert.equal(row().stepup, before, 'a different person leaves no step-up behind');
  step('a different person at the provider cannot complete this person\'s step-up');
  console.log('PASS: real-provider interop (node-oidc-provider), sign-in and step-up');
} catch (error) { console.error(log.slice(-1500)); throw error; }
finally { await browser?.close(); server.kill(); idpServer.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 200); }
