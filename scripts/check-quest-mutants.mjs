import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const suite = ['--test', '--test-concurrency=2', 'test/vision-quest.test.mjs',
  'test/quest-http.test.mjs', 'test/quest-storage-faults.test.mjs'];
const mutations = [
  ['corrections invalidate playback', 'public/vision-quest.js',
    'if (position < 10) playbackAt = -1;', 'if (false) playbackAt = -1;'],
  ['safety covers the whole conversation', 'public/vision-quest.js',
    '.some(turn => safety.test(screenText(`${turn.value} ${turn.note}`)));', '.some(() => false);'],
  ['unfinished corrections block posting', 'public/vision-quest.js',
    "if (Object.hasOwn(doc, 'pending')) throw Error('Save or discard the unsent correction first.');",
    "if (false) throw Error('Save or discard the unsent correction first.');"],
  ['draft identity is checked', 'public/vision-quest.js',
    'doc.person !== person ||', 'false ||'],
  ['stale writers are refused', 'public/quest-storage.js',
    'if (observed !== expectedHead)', 'if (false)'],
  ['import checks its content hash', 'public/quest-storage.js',
    'envelope.sha256 !== await hash(JSON.stringify(envelope.data))', 'false'],
  ['revision bytes are read back', 'public/quest-storage.js',
    'const readback = storage.getItem(revisionKey);', 'const readback = bytes;'],
  ['revision verification precedes publication', 'public/quest-storage.js',
    'storage.setItem(revisionKey, bytes);',
    'storage.setItem(keyFor(doc.person), head);\n    storage.setItem(revisionKey, bytes);'],
];

const run = cwd => spawnSync(process.execPath, suite, { cwd, encoding: 'utf8' });
const baseline = run(root);
if (baseline.status !== 0 || !/# skipped 0\b/.test(baseline.stdout)) {
  process.stderr.write(baseline.stdout + baseline.stderr);
  throw Error('The focused baseline must pass with zero skipped tests.');
}

let survivors = 0;
for (const [name, file, before, after] of mutations) {
  const copy = mkdtempSync(join(tmpdir(), 'sss-quest-mutant-'));
  try {
    cpSync(root, copy, { recursive: true,
      filter: path => !path.includes('/.git') && !path.includes('/node_modules') });
    const target = join(copy, file);
    const original = readFileSync(target, 'utf8');
    if (!original.includes(before)) throw Error(`Mutation source missing: ${name}`);
    writeFileSync(target, original.replace(before, after));
    const result = run(copy);
    const killed = result.status !== null && result.status !== 0 &&
      /# fail [1-9]/.test(result.stdout);
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
    if (!killed) survivors += 1;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
if (survivors) process.exitCode = 1;
