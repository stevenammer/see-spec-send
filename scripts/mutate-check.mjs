import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const mutants = [
  ['micro-dollar cap check', 'if (context.spentMicros + micros > context.capMicros)', 'if (false)', 'test/store.test.mjs', 'money is exact'],
  ['idempotency event compare', 'if (existingHash !== submittedHash)', 'if (false)', 'test/store.test.mjs', 'idempotency keys'],
  ['approval binding', "function currentApproval(state, event) {\n  if (event.approval !== state.approval) return fail('approval does not match current approval');\n  if (event.spec_hash !== state.specHash) return fail('spec hash does not match approved spec');\n  return null;\n}", 'function currentApproval() { return null; }', 'test/store.test.mjs', 'superseded builder'],
  ['role rejection', "if (Object.hasOwn(event, 'role'))", 'if (false)', 'test/store.test.mjs', 'authority is registry-derived'],
  ['immediate transaction', "this.db.exec('BEGIN IMMEDIATE')", "this.db.exec('BEGIN'); this.db.exec('ROLLBACK')", 'test/store.test.mjs', 'real writers'],
  ['revision check', 'if (expectedSeq !== undefined && expectedSeq !== currentSeq)', 'if (false)', 'test/store.test.mjs', 'real writers'],
  ['artifact match', 'event.artifact_hash === context.artifact', 'true', 'test/machine.test.mjs', 'machine needs'],
  ['steward exclusion', 'event.actor !== context.steward && ', '', 'test/machine.test.mjs', 'machine needs'],
  ['stop effect', "stopsBuild(context, 'SPECCED', event.type)", '[]', 'test/machine.test.mjs', 'machine needs'],
  ['chain recomputation', 'const hash = eventHash(previous, row.seq, row.type, row.actor, row.body_hash, row.at);', "const hash = row.hash;", 'test/store.test.mjs', 'verification recomputes'],
  ['erase scope', "if (!target) throw new Error('body is not part of item');", 'if (false) throw new Error();', 'test/store.test.mjs', 'erasure is authorized'],
  ['token scope', "if (row.kind !== 'person' && row.item !== item)", 'if (false)', 'test/store.test.mjs', 'authority is registry-derived'],
];

let failed = false;
for (const [name, find, replace, testFile, testName] of mutants) {
  const copy = mkdtempSync(join(tmpdir(), 'sss-mutant-'));
  cpSync(root, copy, { recursive: true, filter: path => !path.includes('/.git') && !path.includes('/node_modules') });
  const files = ['core/machine.js', 'core/store.js'];
  let changed = false;
  for (const file of files) {
    const path = join(copy, file); const source = readFileSync(path, 'utf8');
    if (!source.includes(find)) continue;
    writeFileSync(path, source.replace(find, replace)); changed = true; break;
  }
  if (!changed) throw new Error(`mutant source missing: ${name}`);
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', testName, testFile], { cwd: copy, stdio: 'pipe', encoding: 'utf8' });
  const killed = result.status !== 0;
  console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
  if (!killed) failed = true;
  rmSync(copy, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
