// Small, explicit review campaign. No full mutation harness and no parallel runners.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const pure = ['test/quest-review-regressions.test.mjs'];
const mutants = [
  ['weak signal overrides setting', 'public/vision-quest.js',
    "} else if (read('setting') === 'works') {", "} else if (signal.score >= signal.threshold && read('setting') === 'works') {", pure],
  ['invisible safety separators', 'public/vision-quest.js',
    'safety.test(screenText(`${turn.value} ${turn.note}`))', 'safety.test(`${turn.value} ${turn.note}`)', pure],
  ['raw conversation persistence', 'public/vision-quest.js',
    'return { ...draft.checked, questMemo:', 'return { ...draft.checked, quest: structuredClone(doc), questMemo:', pure],
  ['restart archives history', 'public/quest-storage.js',
    'if (previous.head && !history.includes(previous.head))', 'if (false)', pure],
  ['restart checks concurrent writer', 'public/quest-storage.js',
    'if (observed !== expectedHead)', 'if (!restart && observed !== expectedHead)', pure],
  ['verify submission hash', 'core/store.js',
    'if (body && body.erased !== 1\n          && submittedEventHash(this.submittedEventFromRow(row), row.idem) !== row.submitted_hash) {',
    'if (false) {', ['--test-name-pattern=verify catches forged submission metadata', 'test/hardening.test.mjs']],
  ['retry ignores JSON key order', 'app/http.js',
    'update(canonical({', 'update(JSON.stringify({', ['--test-name-pattern=quest retries are canonical', 'test/quest-http.test.mjs']],
  ['retry writes duplicate items', 'app/http.js',
    'const prior = input.quest ? store.events(id) : [];', 'const prior = [];',
    ['--test-name-pattern=quest retries are canonical', 'test/quest-http.test.mjs']],
];
const requested = process.argv[2];
const selected = requested ? mutants.filter(([name]) => name === requested) : mutants.slice(0, 5);
if (!selected.length) throw Error('Unknown focused mutant.');
const run = (cwd, args) => spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...args], { cwd, encoding: 'utf8' });
for (const [name, file, before, after, args] of selected) {
  const baseline = run(root, args);
  if (baseline.status !== 0 || !/# pass [1-9]/.test(baseline.stdout)) {
    process.stderr.write(baseline.stdout + baseline.stderr);
    throw Error(`Focused baseline failed: ${name}`);
  }
  const temp = mkdtempSync(join(tmpdir(), 'sss-review-mutant-'));
  try {
    cpSync(root, temp, { recursive: true, filter: path => !path.includes('/.git') && !path.includes('/node_modules') });
    const path = join(temp, file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(before)) throw Error(`Mutant source missing: ${name}`);
    writeFileSync(path, source.replace(before, after));
    const result = run(temp, args);
    if (result.status === null || result.status === 0 || !/# fail [1-9]/.test(result.stdout)) {
      throw Error(`Mutant survived or did not finish: ${name}`);
    }
    console.log(`KILLED ${name}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
