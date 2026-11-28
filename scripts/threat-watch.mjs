#!/usr/bin/env node
// Threat Watch: check what a team runs against public vulnerability feeds and file each new problem as a See.
//
// It reads lockfiles (npm package-lock.json, pinned Python requirements) and any extra packages you name, asks OSV.dev
// which known advisories apply, marks the ones CISA lists as exploited in the wild, and files a See for each new one
// through the signed inbound route (docs/INTEGRATIONS.md). A See from here lands in the Seen stage, labeled
// "documented", like any other integration: a person checks it before it moves. It never fixes, approves or votes.
//
// Dry run by default (prints what it would file). With --send it signs and posts.
//
//   node scripts/threat-watch.mjs --lock package-lock.json [--requirements requirements.txt] \
//     [--package npm:left-pad@1.0.0] [--min-severity moderate] [--state .threat-watch.json] \
//     [--send --url https://sss.example.com --source threat-watch]      (secret in SSS_INBOUND_SECRET)
//
// Network: api.osv.dev and www.cisa.gov, plus your own server with --send. No dependencies, no accounts, no keys.
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
const OSV = 'https://api.osv.dev/v1';
const KEV = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const MAX_PROBLEM = 4000;

export function npmPackages(lockText, where) {
  const lock = JSON.parse(lockText); const seen = new Set(); const out = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.link || !entry.version) continue;
    const name = entry.name || key.split('node_modules/').pop();
    if (seen.has(`${name}@${entry.version}`)) continue;
    seen.add(`${name}@${entry.version}`);
    out.push({ ecosystem: 'npm', name, version: entry.version, where, dev: Boolean(entry.dev) });
  }
  return out;
}

// Only exact pins (name==1.2.3) can be checked; ranges are skipped and counted, never guessed.
export function pythonPackages(text, where) {
  const out = []; let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const pin = line.match(/^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*==\s*([^\s;]+)/);
    if (pin) out.push({ ecosystem: 'PyPI', name: pin[1], version: pin[2], where, dev: false }); else skipped += 1;
  }
  return { packages: out, skipped };
}

export function namedPackage(spec) {
  const m = String(spec).match(/^([A-Za-z.]+):(.+)@([^@]+)$/);
  if (!m) throw new Error(`--package must look like ecosystem:name@version, got ${spec}`);
  return { ecosystem: m[1], name: m[2], version: m[3], where: `${m[2]} (named)`, dev: false };
}

const nums = v => (String(v).match(/\d+/g) || []).map(Number);
export function versionLess(a, b) {
  const x = nums(a); const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

const norm = (eco, name) => (eco.toLowerCase() === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name);
export function fixedVersion(vuln, pkg) {
  let best = null;
  for (const aff of vuln.affected || []) {
    const p = aff.package || {};
    if ((p.ecosystem || '').toLowerCase() !== pkg.ecosystem.toLowerCase() || norm(pkg.ecosystem, p.name || '') !== norm(pkg.ecosystem, pkg.name)) continue;
    for (const range of aff.ranges || []) {
      if (!['ECOSYSTEM', 'SEMVER'].includes(range.type)) continue;
      for (const ev of range.events || []) if (ev.fixed && versionLess(pkg.version, ev.fixed) && (!best || versionLess(ev.fixed, best))) best = ev.fixed;
    }
  }
  return best;
}

export function severityOf(vuln) {
  const s = String(vuln.database_specific?.severity || '').toLowerCase();
  return s === 'medium' ? 'moderate' : SEVERITIES.includes(s) ? s : 'unknown';
}
const rank = s => (SEVERITIES.includes(s) ? SEVERITIES.indexOf(s) : 1); // unknown is treated as moderate: better a See than silence

export async function findings(packages, { fetchJson, cache = {} }) {
  const unique = new Map();
  for (const p of packages) { const k = `${p.ecosystem}\u0000${p.name}\u0000${p.version}`; if (!unique.has(k)) unique.set(k, []); unique.get(k).push(p); }
  const keys = [...unique.keys()]; const out = [];
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const res = await fetchJson(`${OSV}/querybatch`, { queries: chunk.map(k => { const [ecosystem, name, version] = k.split('\u0000'); return { package: { ecosystem, name }, version }; }) });
    chunk.forEach((k, j) => {
      for (const v of res?.results?.[j]?.vulns || []) for (const p of unique.get(k)) out.push({ ...p, id: v.id });
    });
  }
  for (const f of out) {
    cache[f.id] ??= await fetchJson(`${OSV}/vulns/${encodeURIComponent(f.id)}`);
    const vuln = cache[f.id] || {};
    Object.assign(f, { withdrawn: Boolean(vuln.withdrawn), aliases: vuln.aliases || [], summary: vuln.summary || f.id,
      severity: severityOf(vuln), fixed: fixedVersion(vuln, f), link: `https://osv.dev/vulnerability/${f.id}` });
  }
  return out.filter(f => !f.withdrawn);
}

// Feed text is written by strangers. In a See it's one quoted line with no control characters or markup marks, so it
// can't add lines, links or instructions of its own (see docs/PROMPT_INJECTION.md).
export const cleanText = (text, limit = 200) => {
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f`<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > limit ? `${t.slice(0, limit)}...` : t;
};

export const keyOf = f => `${f.id}|${f.ecosystem}|${f.name}|${f.version}|${f.where}`;

// The See text. Plain facts from the advisory; it says what was checked and leaves the decision to people.
export function seeText(f) {
  const ids = [f.id, ...f.aliases.filter(a => a !== f.id)].slice(0, 4).map(i => cleanText(i, 60)).join(', ');
  const name = cleanText(f.name, 120); const version = cleanText(f.version, 60); const where = cleanText(f.where, 200);
  const lines = [
    `${f.exploited ? 'Exploited now: ' : ''}${name} ${version} in ${where} has a known ${f.severity === 'unknown' ? '' : f.severity + ' '}vulnerability.`,
    '',
    `What's wrong (the advisory's own words, not checked): "${cleanText(f.summary)}"`,
    `Where: ${name} ${version} in ${where}${f.dev ? ' (development only)' : ''}. ${ids}.`,
  ];
  if (f.exploited) lines.push('CISA lists this as exploited in the wild.');
  lines.push(`What was checked: the advisory's fixed version is ${f.fixed ? cleanText(f.fixed, 60) : 'not published yet'}.`,
    `Source: https://osv.dev/vulnerability/${encodeURIComponent(f.id)}`);
  return lines.join('\n').slice(0, MAX_PROBLEM);
}

export function signedRequest(secret, body, { now = Date.now(), key }) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(now);
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  return { raw, headers: { 'content-type': 'application/json', 'x-sss-timestamp': timestamp, 'x-sss-signature': `sha256=${signature}`,
    'idempotency-key': `tw-${createHash('sha256').update(key).digest('hex').slice(0, 40)}` } };
}

export async function run({ packages, state = { seen: {} }, kev = new Set(), minSeverity = 'moderate', fetchJson, send = null, log = () => {} }) {
  const found = await findings(packages, { fetchJson, cache: state.cache ??= {} });
  const report = { packages: packages.length, advisories: found.length, new: 0, filed: 0, failed: 0, sees: [] };
  for (const f of found) {
    f.exploited = [f.id, ...f.aliases].some(id => kev.has(id));
    if (!f.exploited && rank(f.severity) < rank(minSeverity)) continue;
    const key = keyOf(f);
    if (state.seen[key]) continue;
    report.new += 1;
    const problem = seeText(f);
    report.sees.push({ key, id: f.id, severity: f.severity, exploited: f.exploited, problem });
    if (!send) { log(`WOULD FILE ${f.severity}${f.exploited ? ' EXPLOITED' : ''}: ${f.name} ${f.version} in ${f.where} (${f.id})`); continue; }
    const ok = await send({ problem, source_label: `Threat Watch: ${f.id}`, honesty_label: 'documented' }, key);
    if (ok) { state.seen[key] = { filed_at: new Date().toISOString() }; report.filed += 1; } else report.failed += 1;
  }
  return report;
}

async function fetchJsonDefault(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

function parseArgs(argv) {
  const a = { locks: [], requirements: [], packages: [], minSeverity: 'moderate', state: '.threat-watch.json', send: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]; const next = () => argv[++i];
    if (flag === '--lock') a.locks.push(next()); else if (flag === '--requirements') a.requirements.push(next());
    else if (flag === '--package') a.packages.push(next()); else if (flag === '--min-severity') a.minSeverity = next();
    else if (flag === '--state') a.state = next(); else if (flag === '--send') a.send = true;
    else if (flag === '--url') a.url = next(); else if (flag === '--source') a.source = next();
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!SEVERITIES.includes(a.minSeverity)) throw new Error(`--min-severity must be one of ${SEVERITIES.join(', ')}`);
  if (a.send && (!a.url || !a.source || !/^https:\/\//.test(a.url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(a.url))) throw new Error('--send needs --source and an https --url (http only for localhost)');
  return a;
}

export async function main(argv = process.argv.slice(2), { fetchJson = fetchJsonDefault, env = process.env, log = console.log } = {}) {
  const a = parseArgs(argv);
  const packages = [];
  for (const lock of a.locks) packages.push(...npmPackages(readFileSync(lock, 'utf8'), lock));
  for (const req of a.requirements) { const r = pythonPackages(readFileSync(req, 'utf8'), req); packages.push(...r.packages); if (r.skipped) log(`${req}: ${r.skipped} lines aren't exact pins, so they weren't checked`); }
  packages.push(...a.packages.map(namedPackage));
  if (!packages.length) throw new Error('nothing to check: pass --lock, --requirements or --package');
  const state = existsSync(a.state) ? JSON.parse(readFileSync(a.state, 'utf8')) : { seen: {} };
  let kev = new Set();
  try { kev = new Set(((await fetchJson(KEV)).vulnerabilities || []).map(v => v.cveID)); } catch { log('CISA exploited list unavailable; continuing without it'); }
  let send = null;
  if (a.send) {
    const secret = env.SSS_INBOUND_SECRET;
    if (!secret || secret.length < 16) throw new Error('set SSS_INBOUND_SECRET (16+ characters) to --send');
    const url = `${a.url.replace(/\/$/, '')}/api/integrations/inbound/${encodeURIComponent(a.source)}`;
    send = async (body, key) => {
      const { raw, headers } = signedRequest(secret, body, { key });
      const res = await fetch(url, { method: 'POST', headers, body: raw, redirect: 'error' });
      if (!res.ok) log(`not filed (${res.status}): ${body.source_label}`);
      return res.ok;
    };
  }
  const report = await run({ packages, state, kev, minSeverity: a.minSeverity, fetchJson, send, log });
  if (a.send) { writeFileSync(`${a.state}.tmp`, JSON.stringify(state)); renameSync(`${a.state}.tmp`, a.state); }
  log(`checked ${report.packages} packages: ${report.advisories} advisories, ${report.new} new at ${a.minSeverity} or above${a.send ? `, ${report.filed} filed, ${report.failed} not filed` : ' (dry run: nothing filed; add --send)'}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`threat-watch: ${error.message}`); process.exit(1); });
}
