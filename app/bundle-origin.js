import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const type = path => path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8'
  : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.json') ? 'application/json; charset=utf-8'
    : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.txt') || path.endsWith('.md') ? 'text/plain; charset=utf-8' : null;
const bad = () => null;
const labelFor = (secret, hash) => `${hash.slice(0, 32)}${createHmac('sha256', secret).update(hash).digest('hex').slice(0, 16)}`;
export const bundleUrl = (secret, hash, hostSuffix, port) => `http://${labelFor(secret, hash)}.${hostSuffix}:${port}/`;

function parse(bytes) {
  try {
    const value = JSON.parse(bytes);
    if (!value || value.sss_bundle !== 1 || Object.keys(value).sort().join(',') !== 'files,manifest,sss_bundle'
      || !value.manifest || value.manifest.version !== 1 || !Array.isArray(value.manifest.files) || !value.files || typeof value.files !== 'object') return bad();
    const paths = new Set(); let total = 0;
    for (const entry of value.manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.split('/').some(x => !x || x === '.' || x === '..') || paths.has(entry.path) || typeof value.files[entry.path] !== 'string') return bad();
      const data = Buffer.from(value.files[entry.path], 'base64');
      if (data.toString('base64') !== value.files[entry.path] || data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) return bad();
      total += data.length; paths.add(entry.path);
    }
    if (Object.keys(value.files).length !== paths.size || total > 1024 * 1024) return bad();
    return { paths, files: value.files };
  } catch { return bad(); }
}

export function createBundleServer({ store, secret, hostSuffix, appOrigin }) {
  if (!Buffer.isBuffer(secret) || !/^[a-z0-9.-]+$/i.test(hostSuffix || '') || !appOrigin) throw Error('invalid bundle server configuration');
  const csp = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${appOrigin}; sandbox allow-scripts allow-same-origin`;
  const server = createServer((req, res) => {
    const no = () => { res.writeHead(404); res.end(); };
    if (!['GET', 'HEAD'].includes(req.method || '')) return no();
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const suffix = `.${hostSuffix.toLowerCase()}`;
    if (!host.endsWith(suffix)) return no();
    const label = host.slice(0, -suffix.length);
    if (!/^[a-f0-9]{48}$/.test(label)) return no();
    const found = store.artifactByHashPrefix(label.slice(0, 32));
    if (!found) return no();
    const expected = Buffer.from(labelFor(secret, found.hash), 'utf8'), received = Buffer.from(label, 'utf8');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return no();
    const raw = req.url || '/';
    if (/%2e|%5c/i.test(raw) || /(?:^|\/)\.\.?\//.test(raw) || raw.includes('\\')) return no();
    let path;
    try { path = new URL(raw, 'http://bundle.invalid').pathname; } catch { return no(); }
    if (path.includes('\\') || path.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) return no();
    path = path === '/' ? 'index.html' : path.slice(1);
    const bundle = parse(found.bytes);
    if (!bundle || !bundle.paths.has(path) || !type(path)) return no();
    const data = Buffer.from(bundle.files[path], 'base64');
    res.writeHead(200, { 'content-type': type(path), 'content-length': data.length, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': csp });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
  server.bundleUrl = (hash, port = server.address()?.port) => bundleUrl(secret, hash, hostSuffix, port);
  server.hostSuffix = hostSuffix;
  return server;
}
