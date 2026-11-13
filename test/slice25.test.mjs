import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, symlinkSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { itemPage } from '../app/pages.js';
import { validateHtml, staticHtmlFromModel, HTML_CAP } from '../worker/builder/index.js';
import { ContainerAdapter, readApprovedOutput } from '../worker/container.js';
import { Worker } from '../worker/runner.js';

const password = 'correct-horse-9-battery';
const page = body => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const dir = () => mkdtempSync(join(tmpdir(), 'sss-slice25-'));
const id = value => value.repeat(64);

// Tag and attribute allowlist for model-built tries (B22). Each entry is a
// document a model could write that the old regex let through, or a rule-level probe.
test('builder output is refused for each B22 bypass and every element or attribute outside the allowlist', () => {
  const refused = {
    'iframe srcdoc with entity-encoded script': page('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'),
    'entity-encoded protocol-relative href': page('<a href="https:&#47;&#47;evil.example">go</a>'),
    'entity-encoded href inside an allowed element': page('<p class="https&#58;&#47;&#47;evil.example">x</p>'),
    'backslash URL in a meta refresh': page('<meta http-equiv="refresh" content="0;url=https:\\\\evil.example">'),
    'empty iframe': page('<iframe></iframe>'),
    'anchor with no entity': page('<a href="#x">x</a>'),
    'comment': page('<!-- hidden --><p>x</p>'),
    'form': page('<form action="/x"><input name="a"></form>'),
    'base element': page('<base href="https://evil.example/">'),
    'event handler on an allowed element': page('<p onclick="x()">x</p>'),
    'colon in a plain attribute': page('<p class="https:evil">x</p>'),
    'backslash in a plain attribute': page('<p class="a\\\\b">x</p>'),
    'ampersand in a plain attribute': page('<p class="a&amp;b">x</p>'),
    'backslash in text': page('<p>C:\\\\temp</p>'),
    'url() in a style element': page('<style>body{background:url(https://evil.example/a.png)}</style>'),
    'import in a style element': page('<style>@import "x.css";</style>'),
  };
  for (const [name, html] of Object.entries(refused))
    assert.throws(() => validateHtml(html), /not a local static page/, name);
});

test('builder output with the allowed structure, text entities and inline style still passes', () => {
  const fine = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Try</title>' +
    '<style>h1{color:#333}.box{padding:4px}</style></head><body><main id="top">' +
    '<h1 class="box">Try</h1><p style="color:#222">Use &lt;b&gt; and &amp; in text.</p>' +
    '<ul><li>one</li></ul><table><tr><td>cell</td></tr></table></main></body></html>';
  assert.equal(validateHtml(fine), fine);
  assert.equal(validateHtml(staticHtmlFromModel(`Sure.\n${fine}`)), fine);
});

test('builder keeps the older refusals (script, handler text, protocol-relative URLs) with their message', () => {
  assert.throws(() => validateHtml(page('<script>1</script>')), /not a local static page/);
  assert.throws(() => validateHtml(page('<p>see https://evil.example</p>')), /not a local static page/);
  assert.throws(() => validateHtml(`<!doctype html>${'x'.repeat(HTML_CAP)}`), /exceeds static HTML cap/);
});

test('container output is read only as a regular, unlinked file no larger than the cap', () => {
  const root = dir();
  const outside = join(root, 'host.html');
  writeFileSync(outside, page('<h1>host file</h1>'));
  const link = join(root, 'linked.html');
  symlinkSync(outside, link);
  assert.throws(() => readApprovedOutput(link), /without following links/, 'a symlink must not be followed');

  const big = join(root, 'big.html');
  writeFileSync(big, 'x'.repeat(HTML_CAP + 1));
  assert.throws(() => readApprovedOutput(big), /exceeds the cap before reading/, 'size is checked before any read');

  const fifo = join(root, 'pipe.html');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo is required for this test');
  assert.throws(() => readApprovedOutput(fifo), /not a regular file/, 'a FIFO must be refused without blocking');

  const good = join(root, 'try.html');
  const html = page('<h1>small</h1>');
  writeFileSync(good, html);
  assert.equal(readApprovedOutput(good), html);
  rmSync(root, { recursive: true, force: true });
});

class FakeLedger {
  mint(_run, _ttl, persist = () => {}) { persist('a'.repeat(64)); return 'b'.repeat(43); }
  revokeDigest() {}
}
const imageFixture = () => {
  const root = dir(); const image = join(root, 'image');
  writeFileSync(image, 'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a\n');
  return { root, image };
}
function containerWith(docker, store = new Store()) {
  const { root, image } = imageFixture();
  const adapter = new ContainerAdapter(store, { docker, ledger: new FakeLedger(), root, gatewaySocket: join(root, 'gw.sock'), imageFile: image });
  return { adapter, store, root };
}
const request = { id: id('a'), item: 'item', approval: 1, spec_hash: id('b'), cap_micros: 0,
  spec: { must: ['m'], how_we_know: ['k'], out_of_scope: [] } };

test('container output directory is sticky, and a symlinked try is refused at the status step', () => {
  const docker = { calls: [], run(args) { this.calls.push(args); return 'cid'; },
    inspect() { return { State: { Running: false, ExitCode: 0 } }; }, kill() {}, remove() {} };
  const { adapter, store, root } = containerWith(docker);
  assert.equal(adapter.modelOutput, true, 'container output is model output');
  adapter.start(request);
  const out = adapter.paths(request.id).out;
  assert.ok((statSync(out).mode & 0o1000) !== 0, 'the output directory must carry the sticky bit');

  const outside = join(root, 'host.html');
  writeFileSync(outside, page('<h1>host</h1>'));
  symlinkSync(outside, adapter.paths(request.id).html);
  assert.equal(adapter.status(request.id).state, 'failed', 'a linked output must not be accepted');
  store.close();
});

test('container output that is a plain small static page is still accepted', () => {
  const docker = { run() { return 'cid'; }, inspect() { return { State: { Running: false, ExitCode: 0 } }; }, kill() {}, remove() {} };
  const { adapter, store } = containerWith(docker);
  adapter.start(request);
  writeFileSync(adapter.paths(request.id).html, page('<h1>ok</h1>'));
  const status = adapter.status(request.id);
  assert.equal(status.state, 'ready');
  assert.match(status.html, /<h1>ok<\/h1>/);
  store.close();
});

function viewerHtml(events) {
  const item = { id: 'i', state: 'TRYING', context: { steward: 'maya', approver: 'lead', helpers: [], quorum: 2,
    artifact: id('c'), ineligibleHelpers: ['maya', 'lead'] } };
  return itemPage(item, events, 'ben', false);
}

test('a model-built try is framed with no script permission', () => {
  const modelEvents = [{ type: 'checked', problem: 'A problem', actor: 'maya' },
    { type: 'tried', actor: 'f'.repeat(64), artifact_hash: id('c'), model_output: true }];
  const model = viewerHtml(modelEvents);
  assert.match(model, /<iframe title="Playable try" sandbox="" src=/);
  assert.doesNotMatch(model, /allow-scripts/);
  const manual = viewerHtml([{ type: 'checked', problem: 'A problem', actor: 'maya' },
    { type: 'tried', actor: 'f'.repeat(64), delivered_by: 'maya', artifact_hash: id('c') }]);
  assert.match(manual, /<iframe title="Playable try" sandbox="allow-scripts" src=/);
});

class ModelAdapter {
  constructor(html) { this.externalStart = false; this.modelOutput = true; this.html = html; }
  start() {}
  status() { return { state: 'ready', html: this.html }; }
  stop() { return { state: 'stopped' }; }
}
function sentItem(adapter, html) {
  const store = new Store();
  store.registerPerson('s'); store.registerPerson('l', { leader: true });
  const put = (type, actor, body = {}) => store.append('i', { type, actor, at: '2026-11-10', ...body },
    { idem: `${type}:${store.events('i').length}` });
  put('checked', 's', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' });
  put('specced', 's', { must: ['x'], how_we_know: ['yes'], out_of_scope: [] });
  put('approved', 'l', { spec_hash: store.read('i').context.specHash, cap_usd: 0, quorum: 1 });
  new Worker(store, adapter).reconcile();
  return { store };
}

test('the artifact route frames a model-built try with no allow-scripts and no script source', async () => {
  const html = page('<h1>model try</h1>');
  const { store } = sentItem(new ModelAdapter(html), html);
  const hash = store.read('i').context.artifact;
  assert.match(hash, /^[a-f0-9]{64}$/, 'the worker delivered the try');
  const auth = new Auth(store); await auth.createUser('ben', password);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://127.0.0.1' });
  const response = await call(handler, 'POST', '/api/login', { id: 'ben', password });
  const cookie = response.headers['set-cookie'].split(';')[0];
  const topLevel = await call(handler, 'GET', `/api/items/i/artifact/${hash}`, undefined, { cookie });
  assert.equal(topLevel.status, 403, 'a top-level open must be refused');
  assert.equal(topLevel.text.includes(html), false);
  const artifact = await call(handler, 'GET', `/api/items/i/artifact/${hash}`, undefined, { cookie, 'sec-fetch-dest': 'iframe' });
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers['content-security-policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'; script-src 'none'");
  assert.equal(artifact.text, html);
  store.close();
});

test('the item page frames a worker-built try with no script permission end to end', async () => {
  const html = page('<h1>model try</h1>');
  const { store } = sentItem(new ModelAdapter(html), html);
  const auth = new Auth(store); await auth.createUser('ben', password);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://127.0.0.1' });
  const response = await call(handler, 'POST', '/api/login', { id: 'ben', password });
  const cookie = response.headers['set-cookie'].split(';')[0];
  const view = await call(handler, 'GET', '/items/i', undefined, { cookie });
  assert.match(view.text, /<iframe title="Playable try" sandbox=""/);
  store.close();
});

// Minimal in-process handler harness, the same shape the other slice tests use. No listener is opened.
class Response { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
async function call(handler, method, path, input, headers = {}) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path;
  req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, headers: res.headers, text: res.text };
}
