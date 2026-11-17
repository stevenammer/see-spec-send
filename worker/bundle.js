import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { validateBundleHtml } from './builder/index.js';

export const BUNDLE_MAX_FILES = 32;
export const BUNDLE_MAX_BYTES = 1024 * 1024;
export const BUNDLE_EXTENSIONS = Object.freeze(['.html', '.css', '.js', '.json', '.svg', '.txt', '.md']);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw Error(`bundle refused: ${reason}`); };
const validPath = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9._/-]+$/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
const extension = path => BUNDLE_EXTENSIONS.find(value => path.endsWith(value));
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;

export function manifestHash(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) fail('invalid manifest');
  return digest(JSON.stringify({ version: manifest.version, files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) }));
}

// The writer must be stopped before this runs. Node lacks openat traversal, so callers
// must exclusively control root while validation reads it.
export function validateBundle(root, manifest, { maxFiles = BUNDLE_MAX_FILES, maxBytes = BUNDLE_MAX_BYTES } = {}) {
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,version' || manifest.version !== 1 || !Array.isArray(manifest.files)
      || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || !manifest.files.length || manifest.files.length > maxFiles) fail('invalid manifest');
  const expected = new Map(); let total = 0;
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256' || !validPath(entry.path) || !extension(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || expected.has(entry.path)) fail('invalid file entry');
    total += entry.bytes; if (!Number.isSafeInteger(total) || total > maxBytes) fail('size limit'); expected.set(entry.path, entry);
  }
  const files = []; const dirs = [];
  function visit(path, relative = '') {
    const before = lstatSync(path, { bigint: true }); if (!before.isDirectory() || before.isSymbolicLink()) fail('invalid directory'); dirs.push([path, before]);
    for (const name of readdirSync(path).sort()) {
      const rel = relative ? `${relative}/${name}` : name; if (!validPath(rel)) fail('invalid path'); const file = join(path, name); const info = lstatSync(file, { bigint: true });
      if (info.isDirectory()) { visit(file, rel); continue; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (info.mode & 0o111n)) fail('unsafe file');
      const entry = expected.get(rel); if (!entry || info.size !== BigInt(entry.bytes)) fail('unexpected file or size');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const initial = fstatSync(fd, { bigint: true }); if (!same(info, initial)) fail('file changed'); const data = Buffer.alloc(entry.bytes + 1); const read = readSync(fd, data, 0, data.length, 0);
        const final = fstatSync(fd, { bigint: true }); if (read !== entry.bytes || !same(initial, final) || !same(final, lstatSync(file, { bigint: true })) || digest(data.subarray(0, read)) !== entry.sha256) fail('file changed or hash mismatch');
        const text = data.subarray(0, read).toString('utf8');
        // A page may link only files that are in this same bundle, resolved from its own folder.
        if (rel.endsWith('.html')) validateBundleHtml(text, new Set([...expected.keys()].map(other => posix.relative(posix.dirname(rel), other)).filter(name => !name.startsWith('..'))));
        if (/\b(?:eval|importScripts)\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bimport\s*\(|\bsendBeacon\b|\bEventSource\b|\bwindow\.open\b|\bdocument\.cookie\b/.test(text)) fail('disallowed script capability');
        // Static pages allow no external URL. Apply that to source files too, including JS/CSS/SVG.
        if (/\b(?:https?:)?\/\/|\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/i.test(text)) fail('external URL or network script');
        files.push(Object.freeze({ path: rel, bytes: read, sha256: entry.sha256 }));
      } finally { closeSync(fd); }
    }
    if (!same(before, lstatSync(path, { bigint: true }))) fail('directory changed');
  }
  visit(root); if (files.length !== expected.size) fail('missing file'); for (const [path, info] of dirs) if (!same(info, lstatSync(path, { bigint: true }))) fail('directory changed');
  return Object.freeze({ manifest: Object.freeze({ version: 1, files: Object.freeze([...manifest.files].sort((a, b) => a.path.localeCompare(b.path))) }), manifest_hash: manifestHash(manifest), files: Object.freeze(files) });
}

// The viewer serves model-built pages with scripts fully disabled (a standing rule). So the reviewable try
// is one document: the entry page with its stylesheets inlined and its script elements removed, plus a
// visible note. Only a bundle that already passed validateBundle should be composed.
// Keep composition independent of the filesystem. Stored bundles use this same path, so the
// script-free fallback is exactly the page that was checked before delivery.
export function composeBundleDocument(manifest, read, known = new Set(manifest.files.map(entry => entry.path))) {
  const entry = manifest.files.map(file => file.path).sort().find(path => path === 'index.html') || manifest.files.map(file => file.path).sort().find(path => path.endsWith('.html'));
  if (!entry) fail('no page in bundle');
  const dir = posix.dirname(entry);
  const resolve = name => posix.normalize(dir === '.' ? name : `${dir}/${name}`);
  let html = read(entry);
  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/gi, (_m, href) => known.has(resolve(href)) ? `<style>${read(resolve(href)).replace(/<\/style/gi, '<\\/style')}</style>` : '');
  // Remove script blocks until nothing changes (one pass can leave a new block behind: `<scr<script></script>ipt>`), then
  // neutralize any `<script` that is still there. The page is also served under a script-free policy; this is the second layer.
  for (let before = ''; before !== html;) { before = html; html = html.replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, ''); }
  html = html.replace(/<script/gi, '&lt;script');
  return html.replace(/<\/body>/i, '<p><small>This build includes scripts. They are not run in the viewer.</small></p></body>');
}

export function bundleArtifact(checked, read) {
  const files = {};
  for (const entry of checked.manifest.files) files[entry.path] = Buffer.from(read(entry.path)).toString('base64');
  // Property insertion order is intentional: this is the canonical stored wire representation.
  return JSON.stringify({ sss_bundle: 1, manifest: checked.manifest, files });
}
