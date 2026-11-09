import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const suite = ['--test', 'test/auth.test.mjs'];
const mutants = [
  ['CSRF token check', "req.headers['x-csrf-token'] !== session?.csrf", 'false'],
  ['Origin check', 'new URL(value).origin === new URL(expected).origin', 'true'],
  ['Origin prefix match', 'new URL(value).origin === new URL(expected).origin', 'String(value).startsWith(expected)'],
  ['SameSite attribute', 'SameSite=Strict', 'SameSite=Lax'],
  ['HttpOnly cookie', '; HttpOnly', ''],
  ['rate limit', 'return this.take(`${action}:ip:${ip}`) && this.take(`${action}:account:${account}`);', 'return true;'],
  ['account lockout', 'Math.min(60 * minute, 1000 * 2 ** failures)', '0'],
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
];

function run(cwd, args) {
  return spawnSync(process.execPath, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const baseline = run(root, ['--test', 'test/auth.test.mjs', 'test/check-public.test.mjs',
  'test/machine.test.mjs', 'test/oracle.test.mjs', 'test/store.test.mjs']);
if (baseline.status !== 0 || /# skipped [^0]/.test(baseline.stdout)) {
  console.error('Baseline suite is not fully green with zero skipped tests.');
  process.stderr.write(baseline.stdout + baseline.stderr);
  process.exit(1);
}

let failed = false;
for (const [name, find, replace] of mutants) {
  const copy = mkdtempSync(join(tmpdir(), 'sss-mutant-'));
  cpSync(root, copy, { recursive: true, filter: path => !path.includes('/.git') && !path.includes('/node_modules') });
  const files = ['app/auth.js', 'app/http.js', 'core/machine.js', 'core/store.js'];
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
  const result = run(copy, changedFile.startsWith('core/')
    ? ['--test', 'test/store.test.mjs', 'test/machine.test.mjs'] : suite);
  const killed = result.status !== 0;
  console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
  failed ||= !killed;
  rmSync(copy, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
