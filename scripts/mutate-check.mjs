import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const mutants = [
  ['cap check', 'if (context.spent + event.usd > context.cap)', 'if (false)'],
  ['role rejection', "if (Object.hasOwn(event, 'role'))", 'if (false)'],
  ['immediate transaction', "this.db.exec('BEGIN IMMEDIATE')", "this.db.exec('BEGIN'); this.db.exec('ROLLBACK')"],
  ['revision check', 'if (expectedSeq !== undefined && expectedSeq !== currentSeq)', 'if (false)'],
  ['artifact match', 'event.artifact_hash === context.artifact', 'true'],
  ['steward exclusion', 'event.actor !== context.steward && ', ''],
  ['stop effect', "stopsBuild(context, 'SPECCED', event.type)", '[]'],
  ['chain recomputation', 'const hash = eventHash(previous, row.seq, row.type, row.actor, row.body_hash, row.at);', "const hash = row.hash;"],
  ['erase scope', "if (!target) throw new Error('body is not part of item');", 'if (false) throw new Error();'],
  ['token scope', "if (row.kind !== 'person' && row.item !== item)", 'if (false)'],
];

let failed = false;
for (const [name, find, replace] of mutants) {
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
  const result = spawnSync(process.execPath, ['--test'], { cwd: copy, stdio: 'pipe', encoding: 'utf8' });
  const killed = result.status !== 0;
  console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
  if (!killed) failed = true;
  rmSync(copy, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
