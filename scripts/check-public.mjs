// Publication guard. Fails if the tree (or its git history) contains secrets,
// private paths, personal emails, backup files, or any term on the denylist.
// The denylist is stored as salted hashes (denylist.json) so this repo never
// publishes the names it blocks. Add terms with scripts/denylist-add.mjs.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function termHash(salt, term) {
  return sha(`${salt}:${normalize(term).replace(/ /g, '')}`);
}

// Every 1 to 3 word window, joined without spaces, so "blue sky", "BlueSky"
// and "BLUE_SKY" all hash the same way.
export function windows(text) {
  const out = new Set();
  const words = normalize(text).split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let n = 0; n < 3 && i + n < words.length; n++) { joined += words[i + n]; out.add(joined); }
  }
  return out;
}

const SECRET_RULES = [
  ['openai-style-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{32,}/],
  ['private-path', /\/home\/[a-z][a-z0-9_-]*\//],
  ['private-network-host', /\b[a-z0-9-]+\.ts\.net\b/],
  ['claude-session-link', /claude\.ai\/code\/session_/],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const SAFE_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.test', 'example.invalid', 'users.noreply.github.com', 'anthropic.com', 'openai.com']);
const FORBIDDEN_FILE = /(^|\/)(\.env(\..*)?|.*\.bak(-.*)?|.*\.pem|.*\.key|\.claude\/.*)$/;

// The denylist is private: it lives on the maintainer's machine, never in this repo.
// Set SSS_DENYLIST to its path, or put it at ~/.config/sss/denylist.json.
export const denylistPath = () => process.env.SSS_DENYLIST || join(homedir(), '.config', 'sss', 'denylist.json');

export function loadDenylist(path = denylistPath()) {
  if (!existsSync(path)) return { salt: '', hashes: new Set() };
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return { salt: j.salt, hashes: new Set(j.hashes) };
}

export function scanText(name, text, denylist) {
  const findings = [];
  if (FORBIDDEN_FILE.test(name) && !/\.env\.example$/.test(name)) findings.push({ rule: 'forbidden-file', name });
  for (const [rule, re] of SECRET_RULES) if (re.test(text)) findings.push({ rule, name });
  for (const m of text.matchAll(EMAIL)) {
    if (!SAFE_EMAIL_DOMAINS.has(m[1].toLowerCase())) { findings.push({ rule: 'personal-email', name }); break; }
  }
  if (denylist.hashes.size) {
    for (const w of windows(text + ' ' + name)) {
      if (denylist.hashes.has(sha(`${denylist.salt}:${w}`))) { findings.push({ rule: 'denylist', name }); break; }
    }
  }
  return findings;
}

function trackedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = (d) => { for (const e of readdirSync(d)) { if (e === '.git' || e === 'node_modules') continue; const p = join(d, e); statSync(p).isDirectory() ? walk(p) : out.push(relative(root, p)); } };
    walk(root); return out;
  }
}

export function scanTree(root, denylist) {
  const findings = [];
  for (const f of trackedFiles(root)) {
    if (f === 'scripts/check-public.mjs') continue;
    let buf; try { buf = readFileSync(join(root, f)); } catch { continue; }
    if (buf.includes(0)) { findings.push(...scanText(f, '', denylist)); continue; }
    findings.push(...scanText(f, buf.toString('utf8'), denylist));
  }
  return findings;
}

export function scanHistory(root, denylist) {
  let log;
  try { log = execFileSync('git', ['-C', root, 'log', '--all', '-p', '--format=%H%n%an%n%ae%n%s%n%b'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch { return []; }
  return scanText('git-history', log, denylist);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = new URL('..', import.meta.url).pathname;
  const dl = loadDenylist();
  const findings = [...scanTree(root, dl), ...scanHistory(root, dl)];
  if (findings.length) {
    for (const f of findings) console.error(`FAIL ${f.rule}: ${f.name}`);
    process.exit(1);
  }
  console.log(`PASS: tree and history checked (${dl.hashes.size ? `${dl.hashes.size} private denylisted terms` : 'no private denylist configured'}, secret formats, private paths, personal emails, backup files).`);
}
