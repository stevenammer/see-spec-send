import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const suite = ['--test', 'test/auth.test.mjs', 'test/hardening.test.mjs', 'test/store.test.mjs',
  'test/machine.test.mjs', 'test/oracle.test.mjs', 'test/web.test.mjs', 'test/web-pages.test.mjs'];
const mutants = [
  ['CSRF token check', "req.headers['x-csrf-token'] !== session?.csrf", 'false'],
  ['Origin check', 'new URL(value).origin === new URL(expected).origin', 'true'],
  ['Origin prefix match', 'new URL(value).origin === new URL(expected).origin', 'String(value).startsWith(expected)'],
  ['SameSite attribute', 'SameSite=Strict', 'SameSite=Lax'],
  ['HttpOnly cookie', '; HttpOnly', ''],
  ['rate limit', 'return this.take(`${action}:ip:${ip}`) && this.take(`${action}:account:${account}`);', 'return true;'],
  ['address lockout backoff', 'Math.min(failureWindow, 1000 * 2 ** pair.n)', '0'],
  ['lockout is per address', 'WHERE account=? AND ip=?', 'WHERE account=? AND (ip=? OR 1=1)'],
  ['account failure ceiling', 'return account.n >= accountFailureCeiling;', 'return false;'],
  ['bucket pruning', 'if (this.buckets.size > 10_000) this.prune();', ''],
  ['bucket hard cap', 'while (this.buckets.size > 50_000)', 'while (false)'],
  ['secure first password', 'randomBytes(18).toString(\'base64url\')', 'Math.random().toString(36).slice(2)'],
  ['database file mode', 'chmodSync(file, 0o600);', 'chmodSync(file, 0o644);'],
  ['backup file mode', 'chmodSync(target, 0o600);', 'chmodSync(target, 0o644);'],
  ['verify submission hash', 'if (body && submittedEventHash(this.submittedEventFromRow(row), row.idem) !== row.submitted_hash) {', 'if (false) {'],
  ['verify idempotency key', 'digest(stable({ idem, event }))', 'digest(stable({ event }))'],
  ['verify orphaned events', "...this.db.prepare('SELECT DISTINCT item FROM events').all().map(row => row.item),", ''],
  ['verify cache drift', "return same ? { item, ok: true } : { item, ok: false, reason: 'cache' };", 'return { item, ok: true };'],
  ['user enumeration', "throw new Error('login unavailable');", "throw new Error('unknown user');"],
  ['step-up freshness', 'row.stepup + 5 * minute < this.clock()', 'false'],
  ['step-up single use', 'AND stepup_used=0', 'AND 1=1'],
  ['invite single use', "UPDATE invites SET used=1 WHERE digest=? AND used=0", "UPDATE invites SET used=1 WHERE digest=?"],
  ['plaintext token storage', 'insert.run(hash(value), kind, item)', 'insert.run(value, kind, item)'],
  ['client-supplied role accepted', "Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'role')", 'false'],
  ['session idle expiry', 'row.seen + 30 * minute <= this.clock()', 'false'],
  ['session rotation on login', 'this.revokePerson(id);', ''],
  ['core role rejection', "if (Object.hasOwn(event, 'role'))", 'if (false)'],
  ['core approval binding', "function currentApproval(state, event) {\n  if (event.approval !== state.approval) return fail('approval does not match current approval');\n  if (event.spec_hash !== state.specHash) return fail('spec hash does not match approved spec');\n  return null;\n}", 'function currentApproval() { return null; }'],
  ['output escaping', '/[&<>"\']/g,', '/NEVER_MATCHES/g,'],
  ['artifact sandbox header', '"sandbox allow-scripts; default-src \'none\'; style-src', '"default-src \'none\'; style-src'],
  ['viewer opaque origin', 'sandbox=\"allow-scripts\"', 'sandbox=\"allow-scripts allow-same-origin\"'],
  ['member deliver', 'if (!(leader || state.context.steward === session.person))', 'if (false)'],
  ['artifact size limit', "Buffer.byteLength(html, 'utf8') > 256 * 1024", 'false'],
  ['HTML CSP', "'content-security-policy': htmlHeaders", "'content-security-policy': \"default-src *\""],
  ['helper count privacy', 'quorum: context.quorum, helpers: context.helpers.length };', 'quorum: context.quorum, helpers: context.helpers.length, helper_names: context.helpers };'],
  ['history shows token hash', 'event.delivered_by || event.actor', 'event.actor'],
  ['approver and steward can vote', 'const canVote = context.steward !== person && context.approver !== person;', 'const canVote = true;'],
  ['artifact stored before stage check', "if (state.state !== 'SENDING') throw new Error('event not allowed');", ''],
  ['checked problem requirement', '&& nonempty(event.problem) && event.problem.length <= 2000', ''],
];

function run(cwd, args) {
  return spawnSync(process.execPath, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const baseline = run(root, [...suite, 'test/check-public.test.mjs']);
if (baseline.status !== 0 || /# skipped [^0]/.test(baseline.stdout)) {
  console.error('Baseline suite is not fully green with zero skipped tests.');
  process.stderr.write(baseline.stdout + baseline.stderr);
  process.exit(1);
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
let failed = false;
for (const [name, find, replace] of mutants) {
  if (only && !name.includes(only)) continue;
  const copy = mkdtempSync(join(tmpdir(), 'sss-mutant-'));
  cpSync(root, copy, { recursive: true, filter: path => !path.includes('/.git') && !path.includes('/node_modules') });
  const files = ['app/auth.js', 'app/http.js', 'app/pages.js', 'core/machine.js', 'core/store.js', 'cli.js'];
  let changed = false;
  let changedFile = '';
  for (const file of files) {
    const path = join(copy, file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(find)) continue;
    writeFileSync(path, source.replace(find, replace));
    changed = true;
    changedFile = file;
    break;
  }
  if (!changed) throw new Error(`mutant source missing: ${name}`);
  const result = run(copy, suite);
  const killed = result.status !== 0;
  console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
  failed ||= !killed;
  rmSync(copy, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
