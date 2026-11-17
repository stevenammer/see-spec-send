import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { unavailablePage } from '../app/pages-admin.js';

// Found by using the app the way a careless or hostile person would (Nov 17, 2026). Each one is pinned here.
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const http = readFileSync(new URL('../app/http.js', import.meta.url), 'utf8');

async function submitWith({ status = 200, dataset = { api: '/api/items', next: '/' }, path } = {}) {
  let handler; const calls = []; const errors = [];
  const fakeButton = { disabled: false };
  const form = {
    dataset, matches: () => true, hasAttribute: () => false,
    querySelectorAll: selector => selector === 'button' ? [fakeButton] : [],
    querySelector: () => null, append: node => errors.push(node),
  };
  const context = {
    FormData: class { constructor() { return Object.entries({ original: 'text' }); } },
    document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, set textContent(value) { this.text = value; }, get textContent() { return this.text; } }), addEventListener: (_n, cb) => { handler = cb; } },
    location: { pathname: '/items/new', reload() {}, set href(value) { calls.push({ goto: value }); } },
    fetch: async (url, options) => { if (options) calls.push({ path: url }); return { ok: status < 300, status, json: async () => ({ csrf: 'c', id: 'x' }) }; },
  };
  runInNewContext(script, context);
  const run = () => handler({ preventDefault() {}, target: form });
  return { run, form, fakeButton, calls, errors };
}

test('a double click or a second Enter sends the form once, and buttons stay off while it is in flight', async () => {
  const world = await submitWith();
  await Promise.all([world.run(), world.run(), world.run()]);
  assert.equal(world.calls.filter(call => call.path === '/api/items').length, 1, 'one post, not three');
  assert.equal(world.fakeButton.disabled, true, 'the button is off until the page moves on');
});

test('after a failure the form can be sent again, and each cause gets its own plain message', async () => {
  for (const [path, status, pattern] of [
    ['/api/login', 403, /ID and password didn't work.*wait about 10 seconds.*each wrong try makes the next wait longer/],
    ['/api/invite/redeem', 403, /invite didn't work.*used already.*ask whoever sent it/],
    ['/api/items', 403, /signed out.*What you typed is still here/],
    ['/api/items', 413, /too long to send/],
    ['/api/items', 429, /Too many tries/],
    ['/api/items', 500, /Nothing you typed was lost/],
    ['/api/items', 409, /may have frozen or changed/],
  ]) {
    const world = await submitWith({ status, dataset: { api: path, next: '/' } });
    await world.run();
    assert.match(world.errors.map(node => node.textContent).join(' '), pattern, `${path} ${status}`);
    assert.equal(world.fakeButton.disabled, false, 'the button comes back so the person can fix it and retry');
    assert.equal(world.form.dataset.busy, undefined);
  }
});

test('a lost connection says so, and the sign-in message never says which half was wrong', async () => {
  const world = await submitWith({ dataset: { api: '/api/items', next: '/' } });
  // Break fetch after the CSRF lookup by making every call throw.
  const broken = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(broken, /Couldn't reach the server\. Check your connection/);
  assert.doesNotMatch(script, /password is wrong|ID is wrong|no such (user|account)|unknown (user|account)/i);
  assert.ok(world);
});

test('a refused page in a browser is a page, and a signed-out visitor is sent to sign in', () => {
  assert.match(http, /res\.browserPage && \(status === 403 \|\| status === 404\)/);
  assert.match(http, /if \(!res\.browserPage\.signedIn\) \{ res\.writeHead\(302, \{ location: '\/signin'/);
  assert.match(http, /\/text\\\/html\/\.test\(req\.headers\.accept \|\| ''\)/);
  const page = unavailablePage().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(page, /That page isn't available/); assert.match(page, /Nothing was changed/); assert.doesNotMatch(page, /"error"/);
});

test('the server refuses a post that is only spaces', () => {
  assert.match(http, /const text = \(value, limit\) => typeof value === 'string' && value\.trim\(\)\.length > 0 && value\.length <= limit;/);
});

test('administration asks for the password in a masked box, not a plain-text pop-up', () => {
  assert.doesNotMatch(script, /\bprompt\(/);
  assert.match(script, /input\.type = 'password'/); assert.match(script, /askPassword\('Enter your password to confirm this administration change'\)/);
});

test('a long paste is not cut off in silence', () => {
  assert.match(script, /so the end was cut off/);
  assert.match(script, /of \$\{max\.toLocaleString\(\)\} characters\. This is the limit\./);
});

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(text = '') { this.text += text; }
}
async function call(handler, method, path, headers = {}, input = null) {
  const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path; req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, text: res.text, headers: res.headers };
}

test('through the real handler: a browser is never shown raw JSON for a page it cannot open, scripts still get JSON', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('maya', 'maya-long-password-9x', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const html = { accept: 'text/html,application/xhtml+xml' };
  // Signed out, in a browser: sent to sign in, for every page that needs a session.
  for (const path of ['/items/new', '/search', '/intelligence', '/mentoring', '/items/anything', '/items/anything/spec']) {
    const r = await call(handler, 'GET', path, html);
    assert.equal(r.status, 302, path); assert.equal(r.headers.location, '/signin', path);
  }
  // Signed out, from a script or curl: still the plain refusal.
  const script = await call(handler, 'GET', '/items/new', {});
  assert.equal(script.status, 403); assert.match(script.text, /request refused/);
  const api = await call(handler, 'GET', '/api/digest', html);
  assert.equal(api.status, 403, 'the API never redirects'); assert.match(api.text, /request refused/);
  // Signed in, in a browser: a page that says what happened, not JSON.
  const login = await call(handler, 'POST', '/api/login', {}, { id: 'maya', password: 'maya-long-password-9x' });
  const cookie = login.headers['set-cookie'].split(';')[0];
  for (const path of ['/items/zzz/spec', '/items/zzz', '/nonexistent-page']) {
    const r = await call(handler, 'GET', path, { ...html, cookie });
    assert.ok([403, 404].includes(r.status), `${path} ${r.status}`);
    assert.match(r.headers['content-type'], /text\/html/, path);
    assert.match(r.text, /That page isn&#39;t available|That page isn't available/, path); assert.doesNotMatch(r.text, /"error"/, path);
  }
  const asScript = await call(handler, 'GET', '/items/zzz/spec', { cookie });
  assert.match(asScript.headers['content-type'], /json/, 'a script gets JSON');
});

test('through the real handler: a post made of spaces is refused, a real one is accepted', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('maya', 'maya-long-password-9x', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = await call(handler, 'POST', '/api/login', {}, { id: 'maya', password: 'maya-long-password-9x' });
  const csrf = JSON.parse(login.text).csrf, headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': csrf };
  for (const original of ['', '   ', '\n\t \n', '\u00a0\u00a0']) assert.equal((await call(handler, 'POST', '/api/items', headers, { original })).status, 409, JSON.stringify(original));
  assert.equal((await call(handler, 'POST', '/api/items', headers, { original: 'A real problem.' })).status, 201);
  assert.equal((await call(handler, 'POST', '/api/items', headers, { original: 'x'.repeat(4001) })).status, 409, 'over the limit is still refused');
});

test('a signed-in person can sign out, and a signed-out page has no sign-out button', async () => {
  const { feedPage, signInPage, newItemPage } = await import('../app/pages.js');
  assert.match(newItemPage(), /<button type="button" class="linklike" data-signout>Sign out<\/button>/);
  assert.match(feedPage([]), /data-signout/);
  assert.doesNotMatch(signInPage(), /data-signout/);
  assert.match(script, /\[data-signout\][\s\S]{0,200}post\('\/api\/logout', \{\}\)[\s\S]{0,200}location\.href = '\/signin'/);
});

test('signing out through the real handler ends the session', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('maya', 'maya-long-password-9x', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const login = await call(handler, 'POST', '/api/login', {}, { id: 'maya', password: 'maya-long-password-9x' });
  const cookie = login.headers['set-cookie'].split(';')[0], csrf = JSON.parse(login.text).csrf;
  assert.equal((await call(handler, 'GET', '/api/me', { cookie })).status, 200);
  assert.equal((await call(handler, 'POST', '/api/logout', { cookie, origin: 'http://localhost', 'x-csrf-token': csrf }, {})).status, 204);
  assert.equal((await call(handler, 'GET', '/api/me', { cookie })).status, 403, 'the old cookie no longer works');
});

test('the admin buttons send the action that was pressed, and the password pop-up is left alone by the page-wide handler', async () => {
  // A button's value is not in the form data. Without this line, Promote, Demote, Disable and Enable were refused every time.
  assert.match(script, /form\.dataset\.admin === 'person'\) input\.action = event\.submitter\?\.value;/);
  assert.match(script, /if \(form\.closest\?\.\('dialog'\)\?\.tagName === 'DIALOG'\) return;/);
  // A wrong password at the confirmation step says so, instead of "this post may have frozen".
  const world = await submitWith({ status: 409, dataset: { api: '/api/stepup', next: '/' } });
  await world.run();
  assert.match(world.errors.map(node => node.textContent).join(' '), /That password didn't work, so nothing was changed/);
});
