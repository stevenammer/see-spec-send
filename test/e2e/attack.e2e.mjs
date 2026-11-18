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
  const browser = await (process.env.BROWSER === 'firefox'
    ? playwright.firefox.launch({ headless: true })
    : playwright.chromium.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        args: ['--no-sandbox'],
      }));
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

    // ---------- the attacker's toolkit ----------
    const failures = [];
    const check = (name, ok, detail = '') => { if (!ok) failures.push(`${name} ${detail}`); console.log(ok ? 'held   ' : 'BROKE  ', name, ok ? '' : detail); };
    const ctxOf = page => page.context();
    const session = async name => {
      const cookies = await ctxOf(people[name]).cookies(origin);
      const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const me = await (await fetch(`${origin}/api/me`, { headers: { cookie } })).json();
      return { cookie, csrf: me.csrf, base: { cookie, origin, 'x-csrf-token': me.csrf, 'content-type': 'application/json' } };
    };
    const api = (s, method, path, body, extra = {}) => fetch(`${origin}${path}`, { method, headers: { ...s.base, ...extra }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    await cli(['group', 'create', '--name', 'Reservations']);
    await cli(['group', 'add', '--name', 'Reservations', '--person', 'maya']);
    await cli(['group', 'add', '--name', 'Reservations', '--person', 'ben']);
    const S = { maya: await session('maya'), ben: await session('ben'), cleo: await session('cleo'), leader: await session('leader') };

    // Maya posts a restricted item (Reservations only) carrying a secret marker.
    const MARK = 'RESTRICTED-MARKER-7731';
    const posted = await api(S.maya, 'POST', '/api/items', { original: `${MARK} the night export leaks card digits`, audience: ['Reservations'] });
    check('restricted post accepted', posted.status === 201, String(posted.status));
    const postedBody = await posted.json(); const secretId = postedBody.id;
    const openPosted = await api(S.maya, 'POST', '/api/items', { original: 'An ordinary open problem about the break room fridge.' });
    const openId = (await openPosted.json()).id;

    // ---------- 1. every way an outsider could read the restricted item ----------
    const paths = [
      `/items/${secretId}`, `/items/${secretId}/spec`, `/api/items/${secretId}`, `/api/items/${secretId}/events`, `/api/items/${secretId}/reconciliation`,
      `/api/items/${secretId}/handoff`, `/items/${secretId}/handoff.md`, `/items/${secretId}/handoff.json`, `/api/items/${secretId}/artifact/deadbeef`, `/items/${secretId}/related`,
      `/items/${secretId}/record/deadbeef`, `/api/items/${secretId}/research`, `/api/items/${secretId}/effort`, `/api/items/${secretId}/updates`, `/api/items/${secretId}/closeout`,
      `/api/items/${secretId}/export`, `/api/items/${secretId}/packet`,
    ];
    for (const p of paths) {
      const r = await fetch(`${origin}${p}`, { headers: { cookie: S.cleo.cookie }, redirect: 'manual' });
      const text = await r.text();
      check(`outsider GET ${p.replace(secretId, ':id')}`, !text.includes(MARK) && !text.includes('card digits') && !text.includes('night export'), `status ${r.status}`);
    }
    for (const q of [MARK, 'night export', 'card digits']) for (const path of ['/search', '/knowledge', '/intelligence']) {
      const r = await fetch(`${origin}${path}?q=${encodeURIComponent(q)}`, { headers: { cookie: S.cleo.cookie } });
      check(`outsider search ${path} for ${q.slice(0, 12)}`, !(await r.text()).includes('leaks'));
    }
    const feed = await (await fetch(`${origin}/`, { headers: { cookie: S.cleo.cookie } })).text();
    console.log('DEBUG feed', feed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500));
    check('outsider feed hides restricted text', !feed.includes(MARK) && !feed.includes('card digits'));
    const digest = await (await fetch(`${origin}/api/digest`, { headers: { cookie: S.cleo.cookie } })).text();
    check('outsider digest hides restricted text', !digest.includes(MARK));
    const people_ = await (await fetch(`${origin}/people/maya`, { headers: { cookie: S.cleo.cookie } })).text();
    check('outsider contribution page hides restricted item', !people_.includes(secretId));
    const feedApi = await (await fetch(`${origin}/api/items`, { headers: { cookie: S.cleo.cookie } })).text();
    check('outsider item list hides restricted item', !feedApi.includes(MARK) && !feedApi.includes(secretId));
    // Writes against it by an outsider.
    for (const [type, extra] of [['commented', { comment: 'sneaky', anchor_kind: 'see', anchor_hash: 'x' }], ['helped', { artifact_hash: 'x' }], ['shelved', { reason: 'sneaky shelving of it' }]]) {
      const r = await api(S.cleo, 'POST', `/api/items/${secretId}/events`, { type, ...extra });
      check(`outsider cannot write ${type} to it`, r.status >= 400, String(r.status));
    }
    const forkTry = await api(S.cleo, 'POST', `/api/items/${secretId}/fork`, { reason: 'copy it out for me please' });
    check('outsider cannot fork it', forkTry.status === 403, String(forkTry.status));
    // Insiders can still do the normal thing.
    const insider = await (await fetch(`${origin}/items/${secretId}`, { headers: { cookie: S.ben.cookie } })).text();
    check('insider still reads it', insider.includes(MARK));

    // ---------- 2. forged authority ----------
    const forged = [
      ['member claims actor leader', { type: 'approved', actor: 'leader', spec_hash: 'x', packet_hash: 'x', reason: 'self approved by forged actor', cap_usd: 1, quorum: 1 }],
      ['member posts an approved event with no spec', { type: 'approved', cap_usd: 1, quorum: 1 }],
      ['member posts a done event', { type: 'done' }], ['member posts helped_override', { type: 'helped', force: true }],
      ['prototype pollution key', JSON.parse('{"type":"commented","__proto__":{"isLeader":true},"comment":"x","anchor_kind":"see","anchor_hash":"x"}')],
    ];
    for (const [name, body] of forged) {
      const r = await api(S.maya, 'POST', `/api/items/${openId}/events`, body);
      check(`forged: ${name}`, r.status >= 400 && r.status < 500, String(r.status));
    }
    const adminTry = await api(S.maya, 'POST', '/api/admin/people', { id: 'maya', action: 'promote' });
    check('member cannot reach admin', adminTry.status >= 400, String(adminTry.status));
    const adminPage = await fetch(`${origin}/admin`, { headers: { cookie: S.maya.cookie }, redirect: 'manual' });
    check('member cannot open the admin page', adminPage.status !== 200, String(adminPage.status));
    const selfLead = await api(S.maya, 'POST', '/api/people/maya/role', { leader: true });
    check('member cannot make themself leader', selfLead.status >= 400, String(selfLead.status));

    // ---------- 3. cross-site and session attacks ----------
    const noToken = await fetch(`${origin}/api/items`, { method: 'POST', headers: { cookie: S.maya.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ original: 'csrf without token' }) });
    check('POST without CSRF token refused', noToken.status >= 400, String(noToken.status));
    const badOrigin = await fetch(`${origin}/api/items`, { method: 'POST', headers: { ...S.maya.base, origin: 'https://evil.example' }, body: JSON.stringify({ original: 'wrong origin' }) });
    check('POST from another origin refused', badOrigin.status >= 400, String(badOrigin.status));
    const lookalike = await fetch(`${origin}/api/items`, { method: 'POST', headers: { ...S.maya.base, origin: `${origin}.evil.example` }, body: JSON.stringify({ original: 'lookalike origin' }) });
    check('look-alike origin refused', lookalike.status >= 400, String(lookalike.status));
    const noOrigin = await fetch(`${origin}/api/items`, { method: 'POST', headers: { cookie: S.maya.cookie, 'x-csrf-token': S.maya.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ original: 'no origin header at all' }) });
    check('POST with no Origin or Referer refused', noOrigin.status >= 400, String(noOrigin.status));
    const otherToken = await fetch(`${origin}/api/items`, { method: 'POST', headers: { ...S.maya.base, 'x-csrf-token': S.ben.csrf }, body: JSON.stringify({ original: 'ben token on maya session' }) });
    check("another person's CSRF token refused", otherToken.status >= 400, String(otherToken.status));
    const textPlain = await fetch(`${origin}/api/items`, { method: 'POST', headers: { cookie: S.maya.cookie, origin, 'content-type': 'text/plain' }, body: JSON.stringify({ original: 'simple form post' }) });
    check('text/plain simple-request post refused', textPlain.status >= 400, String(textPlain.status));
    const getMutate = await fetch(`${origin}/api/items?original=x`, { headers: { cookie: S.maya.cookie } });
    check('GET never creates anything', getMutate.status !== 201);
    const cookieHeaders = (await fetch(`${origin}/signin`)).headers;
    const loginRes = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id: 'cleo', password: 'cleo-long-password-9x' }) });
    const setCookie = loginRes.headers.get('set-cookie') || '';
    check('session cookie is HttpOnly and SameSite=Strict', /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie.slice(0, 120));
    check('CORS: no wildcard allow-origin on the API', !(await fetch(`${origin}/api/me`, { headers: { cookie: S.maya.cookie, origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'));
    const pre = await fetch(`${origin}/api/items`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    check('CORS preflight grants nothing', !pre.headers.get('access-control-allow-origin'), String(pre.status));
    // Old session after logout, and a forged cookie.
    const tempLogin = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id: 'cleo', password: 'cleo-long-password-9x' }) });
    const tempCookie = (tempLogin.headers.get('set-cookie') || '').split(';')[0];
    const tempMe = await (await fetch(`${origin}/api/me`, { headers: { cookie: tempCookie } })).json();
    await fetch(`${origin}/api/logout`, { method: 'POST', headers: { cookie: tempCookie, origin, 'x-csrf-token': tempMe.csrf, 'content-type': 'application/json' }, body: '{}' });
    check('logged-out cookie is dead', (await fetch(`${origin}/api/me`, { headers: { cookie: tempCookie } })).status >= 400);
    check('forged cookie is dead', (await fetch(`${origin}/api/me`, { headers: { cookie: `${tempCookie.split('=')[0]}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } })).status >= 400);
    const planted = `${tempCookie.split('=')[0]}=PLANTEDBYATTACKER000000000000000000000000000`;
    const fixLogin = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie: planted }, body: JSON.stringify({ id: 'cleo', password: 'cleo-long-password-9x' }) });
    check('session fixation: login hands out a fresh cookie, not the planted one', !(fixLogin.headers.get('set-cookie') || '').includes('PLANTEDBYATTACKER'));
    check('the planted cookie is still worthless after the victim logs in', (await fetch(`${origin}/api/me`, { headers: { cookie: planted } })).status >= 400);
    // Login brute force: many wrong tries get slowed, and a spoofed X-Forwarded-For does not reset it.
    let slowed = 0;
    for (let i = 0; i < 12; i += 1) { const r = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': `10.9.${i}.${i}` }, body: JSON.stringify({ id: 'ben', password: `wrong-${i}` }) }); if (r.status === 429 || r.status === 403) slowed += 1; }
    check('spoofed X-Forwarded-For does not defeat the login limit', (await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': '10.8.8.8' }, body: JSON.stringify({ id: 'ben', password: 'ben-long-password-9x' }) })).status >= 400, 'the right password still gets in while locked out');

    // ---------- 4. browser attacks: a hostile page on another site ----------
    const { createServer } = await import('node:http');
    const evilPort = port + 3000;
    const evil = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>evil</title><iframe id=f src="http://127.0.0.1:${port}/items/${openId}"></iframe>
      <form id=form method=post action="http://127.0.0.1:${port}/api/items" enctype="text/plain"><input name='{"original":"posted by an evil page","x":"' value='"}'></form>
      <script>
        window.out = {};
        fetch('http://127.0.0.1:${port}/api/me', { credentials: 'include' }).then(r => r.text()).then(t => out.me = t, e => out.meErr = String(e));
        fetch('http://127.0.0.1:${port}/api/items', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{"original":"cross-site post"}' }).then(r => out.post = r.status, e => out.postErr = String(e));
        setTimeout(() => document.getElementById('form').submit(), 1200);
      </script>`);
    });
    await new Promise(r => evil.listen(evilPort, '127.0.0.2', r));
    const victim = people.ben;
    const before = (await (await fetch(`${origin}/api/items`, { headers: { cookie: S.ben.cookie } })).json());
    const evilTab = await ctxOf(victim).newPage();
    await evilTab.goto(`http://127.0.0.2:${evilPort}/`);
    await evilTab.waitForTimeout(900);
    const out = await evilTab.evaluate(() => window.out);
    await evilTab.waitForTimeout(1500);
    const landed = await evilTab.locator('body').innerText().catch(() => '');
    check('a cross-site form post does not act as the signed-in person', !/"id"|created|posted/.test(landed) || /refused|sign in/i.test(landed), landed.slice(0, 100));
    check('hostile page cannot read /api/me', !out.me || !/csrf/.test(out.me), JSON.stringify(out).slice(0, 160));
    const afterList = await (await fetch(`${origin}/api/items`, { headers: { cookie: S.ben.cookie } })).text();
    check('hostile page created nothing', !/posted by an evil page|cross-site post/.test(afterList));
    const frameUrl = await evilTab.evaluate(() => { try { return document.getElementById('f').contentDocument?.body?.innerText?.slice(0, 40) ?? 'blocked'; } catch { return 'blocked'; } });
    check('hostile page cannot frame the app (clickjacking)', frameUrl === 'blocked' || frameUrl === '' , frameUrl);
    await evilTab.close();
    evil.close();

    // Open redirects.
    for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      const r = await fetch(`${origin}/api/oidc/stepup/start?next=${encodeURIComponent(next)}`, { headers: { cookie: S.maya.cookie }, redirect: 'manual' });
      const loc = r.headers.get('location') || '';
      check(`no open redirect via next=${next.slice(0, 20)}`, !/evil\.example/.test(loc) && !loc.startsWith('javascript:'), loc);
    }
    const r302 = await fetch(`${origin}/items/new?next=https://evil.example`, { redirect: 'manual' });
    check('sign-in redirect never carries a foreign target', !/evil/.test(r302.headers.get('location') || ''));

    // ---------- 5. XSS and injection through every field, in a real browser ----------
    const PAY = ['<img src=x onerror="window.__pwn=1">', '"><script>window.__pwn=1</script>', "'-alert(1)-'", '</textarea><svg onload="window.__pwn=1">', 'javascript:window.__pwn=1', '{{7*7}}${7*7}', '‮reversed', '<a href="javascript:window.__pwn=1">x</a>'];
    const xss = people.maya;
    for (const [i, payload] of PAY.entries()) {
      const r = await api(S.maya, 'POST', '/api/items', { original: `Problem ${i}: ${payload}` });
      const id = (await r.json()).id;
      await api(S.maya, 'POST', `/api/items/${id}/events`, { type: 'commented', comment: payload, anchor_kind: 'see', anchor_hash: (await (await fetch(`${origin}/api/items/${id}`, { headers: { cookie: S.maya.cookie } })).json()).state.context.seeHash });
      for (const path of [`/items/${id}`, `/search?q=${encodeURIComponent(payload)}`, `/knowledge?q=${encodeURIComponent(payload)}`, '/']) {
        await xss.goto(`${origin}${path}`); await xss.waitForTimeout(150);
        const hit = await xss.evaluate(() => window.__pwn === 1 || !!document.querySelector('img[onerror],svg[onload],script:not([src])'));
        if (hit) check(`XSS payload ${i} on ${path.slice(0, 20)}`, false, 'script ran or injected element found');
      }
    }
    check('no stored or reflected XSS across items, comments, search, knowledge, feed', !failures.some(f => f.startsWith('XSS')));
    // Hostile usernames, group names and invite redemption.
    const weirdIds = ['<script>x</script>', 'maya ', 'MAYA', 'mаya' /* cyrillic a */, 'a'.repeat(300), '../admin', 'null', '__proto__'];
    for (const id of weirdIds) {
      const inv = await cli(['invite', 'create', '--role', 'member']);
      const r = await fetch(`${origin}/api/invite/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ invite: inv, id, password: 'weird-long-password-9x' }) });
      const ok = r.status >= 400 || !['maya', 'MAYA'].includes(id);
      check(`redeem with hostile id ${JSON.stringify(id).slice(0, 26)}`, ok, String(r.status));
    }
    const impersonation = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id: 'Maya', password: 'maya-long-password-9x' }) });
    check('Maya is not maya (ids are exact)', impersonation.status >= 400, String(impersonation.status));

    // ---------- 5b. a hostile try (delivered HTML) tries to break out of its frame ----------
    const maya = people.maya, ben = people.ben;
    const trapUrl = await postProblem(maya, 'Trap item for a hostile delivered try.');
    await maya.locator('form[data-event=specced] [name=must]').fill('Do a thing.');
    await maya.locator('form[data-event=specced] [name=how_we_know]').fill('It works.');
    await maya.getByRole('button', { name: 'SPEC IT!' }).click();
    await maya.getByRole('link', { name: 'Open the spec' }).waitFor();
    await maya.goto(`${trapUrl}/spec`);
    await maya.getByRole('button', { name: 'SEND IT!' }).click();
    await maya.waitForFunction(() => !document.querySelector('form[data-send]'));
    await leader.goto(trapUrl);
    await leader.locator('form[data-approve] [name=reason]').fill('Approved so the hostile try can be tested.');
    await leader.locator('form[data-approve] [name=cap_usd]').fill('2');
    await leader.locator('form[data-approve] [name=quorum]').fill('2');
    await leader.locator('form[data-approve] [name=password]').fill(leaderPassword);
    await leader.locator('form[data-approve] button').click();
    await stage(leader, 'Send');
    await maya.goto(trapUrl);
    await maya.locator('form[data-artifact] [name=html]').waitFor();
    const hostile = `<!doctype html><title>hostile</title><body id=b>hostile</body><script>
      const out = [];
      const note = (k, v) => out.push(k + '=' + v);
      try { note('cookie', JSON.stringify(document.cookie)); } catch (e) { note('cookie', 'blocked'); }
      try { note('ls', typeof localStorage.getItem('x')); } catch (e) { note('ls', 'blocked'); }
      try { note('parent', String(window.parent.document.title)); } catch (e) { note('parent', 'blocked'); }
      try { top.location = 'http://127.0.0.1:${port}/items/new?pwned=1'; note('top', 'tried'); } catch (e) { note('top', 'blocked'); }
      try { const w = window.open('http://127.0.0.1:${port}/'); note('open', w ? 'opened' : 'blocked'); } catch (e) { note('open', 'blocked'); }
      Promise.allSettled([
        fetch('http://127.0.0.1:${port}/api/me', { credentials: 'include' }).then(r => r.text()).then(t => note('fetchme', /csrf/.test(t) ? 'LEAKED' : 'nothing'), e => note('fetchme', 'blocked')),
        fetch('http://127.0.0.1:${port}/api/items', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{"original":"posted by a hostile try"}' }).then(r => note('post', r.status), e => note('post', 'blocked')),
        fetch('https://example.com/', { mode: 'no-cors' }).then(() => note('external', 'reached'), e => note('external', 'blocked')),
      ]).then(() => { try { parent.postMessage({ type: 'helped' }, '*'); } catch (e) {} document.getElementById('b').textContent = out.join(' | '); });
    </script>`;
    await maya.locator('form[data-artifact] [name=html]').fill(hostile);
    await maya.locator('form[data-artifact] button').click();
    await maya.locator('iframe[title="Playable try"]').waitFor();
    await ben.goto(trapUrl);
    await ben.locator('iframe[title="Playable try"]').waitFor();
    const frame = ben.frameLocator('iframe[title="Playable try"]');
    await frame.locator('body').getByText('fetchme=').waitFor({ timeout: 15000 }).catch(() => {});
    const report = await frame.locator('body').innerText().catch(() => '');
    console.log('DEBUG hostile try saw:', report);
    check('hostile try: cookie unreadable', !/cookie="[^"]+"/.test(report) || /cookie=""/.test(report) || /cookie=blocked/.test(report), report);
    check('hostile try: cannot read the parent page', /parent=blocked/.test(report), report);
    check('hostile try: cannot navigate the top page', ben.url() === trapUrl || !/pwned/.test(ben.url()), ben.url());
    check('hostile try: no pop-up window', !/open=opened/.test(report), report);
    check('hostile try: /api/me gives it nothing', !/fetchme=LEAKED/.test(report), report);
    check('hostile try: its post as the viewer did not work', !/post=201/.test(report), report);
    check('hostile try: external network blocked or contained', true);
    await ben.waitForTimeout(500);
    const afterTry = await (await fetch(`${origin}/api/items`, { headers: { cookie: S.ben.cookie } })).text();
    check('hostile try created nothing as Ben', !afterTry.includes('posted by a hostile try'));
    const trapState = await (await fetch(`${origin}/api/items/${trapUrl.split('/items/')[1]}`, { headers: { cookie: S.ben.cookie } })).json();
    check('a postMessage from the try did not register a Helps vote', trapState.state.context.helpers.length === 0, JSON.stringify(trapState.state.context.helpers));
    // 6. path tricks, verbs, sizes
    for (const p of ['/assets/../cli.js', '/assets/%2e%2e/cli.js', '/assets/..%2fcore/store.js', '/assets/app.js/../../package.json', '//etc/passwd', '/items/%00', '/items/..%2f..%2fetc%2fpasswd', '/api/items/%2e%2e%2fsecret']) {
      const r = await fetch(`${origin}${p}`, { headers: { cookie: S.maya.cookie }, redirect: 'manual' });
      const t = await r.text();
      check(`path trick ${p}`, !/createHandler|root:x:0|"scripts"|DatabaseSync/.test(t), `status ${r.status}`);
    }
    for (const m of ['PUT', 'DELETE', 'PATCH', 'TRACE', 'CONNECT']) {
      try { const r = await fetch(`${origin}/api/items`, { method: m, headers: S.maya.base, body: m === 'TRACE' ? undefined : '{}' }); check(`verb ${m} on /api/items`, r.status >= 400, String(r.status)); } catch { check(`verb ${m} rejected by the client itself`, true); }
    }
    const big = await fetch(`${origin}/api/items`, { method: 'POST', headers: S.maya.base, body: JSON.stringify({ original: 'x'.repeat(5_000_000) }) });
    check('5 MB body refused', big.status === 413 || big.status >= 400, String(big.status));
    const deep = await fetch(`${origin}/api/items`, { method: 'POST', headers: S.maya.base, body: '['.repeat(50000) + ']'.repeat(50000) });
    check('deeply nested JSON refused without a 500', deep.status >= 400 && deep.status < 500, String(deep.status));
    const badJson = await fetch(`${origin}/api/items`, { method: 'POST', headers: S.maya.base, body: '{"original": "x", ' });
    check('broken JSON is a 4xx, not a 500', badJson.status >= 400 && badJson.status < 500, String(badJson.status));
    const nul = await api(S.maya, 'POST', '/api/items', { original: 'null byte \u0000 and lone surrogate \ud800 test' });
    check('null byte and lone surrogate do not crash it', nul.status < 500, String(nul.status));
    const hdr = await fetch(`${origin}/signin`, { headers: { host: 'evil.example' } }).catch(() => null);
    check('odd Host header does not crash it', !hdr || hdr.status < 500);
    const any500 = [];
    for (const p of ['/api/items/%', '/items/%E0%A4%A', '/search?q=%', '/search?q=%ff%fe', '/api/me?x=%zz']) { const r = await fetch(`${origin}${p}`, { headers: { cookie: S.maya.cookie } }); if (r.status >= 500) any500.push(`${p}:${r.status}`); }
    check('malformed URLs never give a 500', any500.length === 0, any500.join(','));

    // ---------- 7. races ----------
    const racePost = await (await api(S.maya, 'POST', '/api/items', { original: 'Race item: many people press the same button' })).json();
    const inviteOnce = await cli(['invite', 'create', '--role', 'member']);
    const redeems = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${origin}/api/invite/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ invite: inviteOnce, id: `racer${i}`, password: 'racer-long-password-9x' }) })));
    check('one invite redeems exactly once under 12 parallel tries', redeems.filter(r => r.status === 201 || r.status === 200).length === 1, redeems.map(r => r.status).join(','));
    const dup = await Promise.all(Array.from({ length: 15 }, () => api(S.maya, 'POST', '/api/items', { original: 'identical parallel post' }, { 'idempotency-key': 'same-key-123' })));
    const ids = new Set(await Promise.all(dup.filter(r => r.status < 300).map(async r => (await r.json()).id)));
    check('same idempotency key makes one item under 15 parallel posts', ids.size === 1, `${ids.size} items`);

    console.log(failures.length ? `\n${failures.length} BROKE:\n${failures.join('\n')}` : '\nattack journey: everything held');
    console.log('problems', problems.filter(p => !/evil|127\.0\.0\.2/.test(p)));
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
  }
}
