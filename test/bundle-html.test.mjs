import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
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
