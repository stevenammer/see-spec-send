import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBundleHtml, validateHtml } from '../worker/builder/index.js';
import { validateBundle } from '../worker/bundle.js';

const links = new Set(['app.js', 'style.css']);
const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>T</title>${body}</head><body><textarea id="n"></textarea></body></html>`;

test('a bundle page may link its own script and stylesheet, and the single-file validator still refuses them', () => {
  const html = page('<link rel="stylesheet" href="style.css"><script src="app.js" defer></script>');
  assert.equal(validateBundleHtml(html, links), html);
  assert.throws(() => validateHtml(html), /not a local static page/);
});

test('bundle pages still refuse inline script, handlers, external or unknown files, wrong rel and script text', () => {
  const bad = [
    page('<script>alert(1)</script>'), page('<script src="app.js">alert(1)</script>'), page('<script src="other.js"></script>'),
    page('<script src="https://evil.test/x.js"></script>'), page('<script src="//evil.test/x.js"></script>'), page('<script src="../app.js"></script>'),
    page('<link rel="icon" href="style.css">'), page('<link rel="stylesheet" href="http://evil.test/a.css">'),
    page('<script src="app.js" type="module"></script>'), page('<script src="data:text/javascript,1"></script>'),
    '<!doctype html><html><body onclick="x()"><textarea></textarea></body></html>', page('<iframe src="app.js"></iframe>'),
    page('<script src="app.js"></script><script>x</script>'),
  ];
  for (const html of bad) assert.throws(() => validateBundleHtml(html, links), /not a local static page|not static/, html.slice(0, 80));
  assert.throws(() => validateBundleHtml(page('<script src="app.js"></script>'), new Set()), /not a local static page/, 'no sibling files means no links');
});

function bundle(files) {
  const root = mkdtempSync(join(tmpdir(), 'sss-bundle-'));
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true }); writeFileSync(join(root, path), text, { mode: 0o644 }); }
  const manifest = { version: 1, files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })) };
  return { root, manifest };
}
const good = { 'index.html': page('<link rel="stylesheet" href="style.css"><script src="app.js"></script>'), 'style.css': 'body{margin:0}', 'app.js': "document.getElementById('n').addEventListener('input',e=>localStorage.setItem('n',e.target.value));" };

test('a real three-file bundle validates, and script capabilities that could reach out are refused', () => {
  const ok = bundle(good);
  assert.deepEqual(validateBundle(ok.root, ok.manifest).files.map(f => f.path).sort(), ['app.js', 'index.html', 'style.css']);
  for (const evil of ["eval('1')", 'new Function("1")()', "import('x')", "navigator.sendBeacon('/x')", 'new EventSource("x")', 'window.open("x")', 'document.cookie = "a=1"', "fetch('/x')", "new WebSocket('x')"]) {
    const b = bundle({ ...good, 'app.js': evil });
    assert.throws(() => validateBundle(b.root, b.manifest), /refused/, evil);
  }
  const outside = bundle({ ...good, 'index.html': page('<script src="elsewhere/app.js"></script>') });
  assert.throws(() => validateBundle(outside.root, outside.manifest), /refused|not a local static page/);
});

import { composeBundleDocument } from '../worker/bundle.js';
test('the reviewable try is one script-free document with the stylesheet inlined and a visible note', () => {
  const b = bundle(good);
  const checked = validateBundle(b.root, b.manifest);
  const html = composeBundleDocument(checked.manifest, path => readFileSync(join(b.root, path), 'utf8'));
  assert.match(html, /<style>body\{margin:0\}<\/style>/);
  assert.doesNotMatch(html, /<script/i, 'scripts are not part of the delivered try');
  assert.doesNotMatch(html, /href="style\.css"|src="app\.js"/);
  assert.match(html, /not run in the viewer/);
  assert.match(html, /<textarea id="n">/, 'the page markup is kept');
});

test('the reviewable view leaves no script behind, even for nested, inline, unclosed or oddly spelled script tags', () => {
  const pages = [
    '<scr<script></script>ipt>alert(1)</script>',
    '<SCRIPT >alert(1)</SCRIPT >',
    '<script src="a.js"></script><script>alert(1)</script>',
    '<scr<script></script>i<script></script>pt>alert(1)</scr<script></script>ipt>',
    '<script>alert(1)',
    '<p>ok</p><script\n>alert(1)</script\t\n>',
  ];
  for (const page of pages) {
    const html = composeBundleDocument({ files: [{ path: 'index.html' }] }, () => `<!doctype html><html><body>${page}</body></html>`);
    assert.doesNotMatch(html, /<script/i, `still has a script: ${page}`);
  }
});

test('the doctype check ignores case in both validators, and a page with no doctype is refused', () => {
  for (const doctype of ['<!doctype html>', '<!DOCTYPE html>', '<!DocType HTML>']) {
    const html = `${doctype}<html><head><meta charset="utf-8"><title>T</title></head><body><p>hi</p></body></html>`;
    assert.equal(validateBundleHtml(html, links), html, `bundle validator, ${doctype}`);
    assert.equal(validateHtml(html), html, `single-file validator, ${doctype}`);
  }
  const bare = '<html><head><title>T</title></head><body><p>hi</p></body></html>';
  assert.throws(() => validateBundleHtml(bare, links), /not static HTML/);
  assert.throws(() => validateHtml(bare), /not static HTML/);
});

test('a bundle may use form, fieldset and legend, which carry no authority; a single-file page still may not', () => {
  const structured = page('<label for="a">A</label><input id="a" type="text"><button type="button" id="go">Go</button>')
    .replace('<body>', '<body><form id="f"><fieldset id="s"><legend>Questions</legend>').replace('</body>', '</fieldset></form></body>');
  assert.equal(validateBundleHtml(structured, links), structured);
  assert.throws(() => validateHtml(structured), /not a local static page/, 'the one-shot builder still refuses form markup');
  for (const attribute of ['action="x"', 'method="post"', 'target="_top"', 'onsubmit="x()"', 'formaction="x"']) {
    const bad = structured.replace('<form id="f">', `<form id="f" ${attribute}>`);
    assert.throws(() => validateBundleHtml(bad, links), /not a local static page/, `${attribute} on a form is still refused`);
  }
  assert.throws(() => validateBundleHtml(structured.replace('<legend>', '<legend title="x">'), links), /not a local static page/, 'attributes outside the allowlist are still refused on the new elements');
});

test('a refused bundle says exactly why, in words an agent can act on, and names the file', () => {
  const reason = (html, run = html => validateBundleHtml(html, links)) => { try { run(html); } catch (error) { return error.detail; } return null; };
  assert.match(reason(page('<a>x</a>')), /the element <a> is not allowed/);
  assert.match(reason(page('<p aria-label="x">hi</p>')), /the attribute aria-label is not allowed on <p>/);
  assert.match(reason(page('<button type="button" onclick="x()">go</button>')), /on-attribute/);
  assert.match(reason(page('<p>see http://example.test</p>')), /URL or a double slash/);
  assert.match(reason(page('<p title="a:b">x</p>')), /the attribute title is not allowed on <p>/);
  assert.match(reason(page('<input type="text" value="a:b">')), /value of value on <input> must not contain a colon/);
  assert.match(reason('<html></html>'), /must start with <!doctype html>/);
  assert.match(reason(page('<script src="nope.js"></script>')), /must name a file you wrote/);
  const root = mkdtempSync(join(tmpdir(), 'sss-detail-'));
  writeFileSync(join(root, 'index.html'), page('<a>x</a>'));
  const manifest = { version: 1, files: [{ path: 'index.html', bytes: Buffer.byteLength(page('<a>x</a>')), sha256: createHash('sha256').update(page('<a>x</a>')).digest('hex') }] };
  assert.match(reason(null, () => validateBundle(root, manifest)), /^index\.html: the element <a> is not allowed/, 'the detail names the file');
  assert.match(reason(null, () => validateBundle(root, { version: 1, files: [] })), /no files were found in \.\/bundle\//);
});

test('a link to a sibling file may start with ./ (the same file), but nothing that goes up or out is accepted', () => {
  const linked = value => page(`<link rel="stylesheet" href="${value}"><script src="${value.replace('style.css', 'app.js')}"></script>`);
  assert.doesNotThrow(() => validateBundleHtml(linked('style.css'), links));
  assert.doesNotThrow(() => validateBundleHtml(linked('./style.css'), links), 'a leading ./ names the same file');
  for (const bad of ['../style.css', '/style.css', './/style.css', './../style.css', 'https:style.css', './other.css']) {
    assert.throws(() => validateBundleHtml(linked(bad), links), /not a local static page/, bad);
  }
  try { validateBundleHtml(linked('./nope.css'), links); } catch (error) { assert.match(error.detail, /just the file name from the page's own folder \(like style\.css\)/, 'the reason tells the agent the actual rule'); }
});
