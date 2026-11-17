// Judges a finished bundle by running it in real Chrome and asking the task's questions. It also records any
// request the page tried to make outside its own folder, because a builder that reaches the network has failed.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/markdown' };

export function manifestFor(root) {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else { const bytes = readFileSync(path); files.push({ path: relative(root, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); } } };
  walk(root);
  return { version: 1, files };
}

export async function judgeBundle(root, task, { playwrightDir = process.env.PLAYWRIGHT_DIR || '', chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome', timeoutMs = 8000 } = {}) {
  const require = createRequire(import.meta.url);
  const playwright = require(join(playwrightDir, 'playwright'));
  const server = createServer((req, res) => {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const body = readFileSync(path); res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
  const checks = []; const outside = []; const errors = [];
  try {
    const context = await browser.newContext();
    await context.route(url => !url.href.startsWith(origin), route => { outside.push(route.request().url()); route.abort(); });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on('pageerror', error => errors.push(String(error.message).slice(0, 160)));
    let current = null;
    const ck = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); };
    try { await task.accept(page, ck, `${origin}/index.html`); }
    catch (error) { checks.push({ name: `the page could not be driven (${String(error.message).split('\n')[0].slice(0, 120)})`, ok: false }); }
    checks.push({ name: 'made no request outside its own folder', ok: outside.length === 0 });
    return { checks, passed: checks.filter(c => c.ok).length, total: checks.length, ok: checks.every(c => c.ok), outside, errors };
  } finally { await browser.close(); server.close(); }
}
