import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drifted, sync, header } from '../scripts/sync-demo.mjs';

test('demo/lib/machine.js is exactly core/machine.js plus the generated header', () => {
  assert.deepEqual(drifted(), []);
  const source = readFileSync(new URL('../core/machine.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../demo/lib/machine.js', import.meta.url), 'utf8');
  assert.equal(copy, header + source);
});

test('the check fails when the copy is edited, missing, or the source changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sss-drift-'));
  try {
    mkdirSync(join(root, 'core'));
    mkdirSync(join(root, 'public'));
    cpSync(new URL('../core/machine.js', import.meta.url), join(root, 'core/machine.js'));
    cpSync(new URL('../public/vision-quest.js', import.meta.url), join(root, 'public/vision-quest.js'));
    assert.deepEqual(drifted(root), ['demo/lib/machine.js', 'demo/lib/vision-quest.js'], 'missing copies count as drift');
    sync(root);
    assert.deepEqual(drifted(root), []);
    const copy = join(root, 'demo/lib/machine.js');
    writeFileSync(copy, readFileSync(copy, 'utf8').replace("'TRYING'", "'TRYING '"));
    assert.deepEqual(drifted(root), ['demo/lib/machine.js'], 'a hand edit is drift');
    sync(root);
    writeFileSync(join(root, 'core/machine.js'), `${readFileSync(join(root, 'core/machine.js'), 'utf8')}\n// changed\n`);
    assert.deepEqual(drifted(root), ['demo/lib/machine.js'], 'a source change is drift');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the demo log imports the generated machine and defines no transitions of its own', () => {
  const log = readFileSync(new URL('../demo/lib/log.js', import.meta.url), 'utf8');
  assert.match(log, /from '\.\/machine\.js'/);
  for (const file of ['log', 'flow', 'rules', 'tour', 'render', 'roster']) {
    const code = readFileSync(new URL(`../demo/lib/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /phase\s*:\s*'(SENDING|TRYING|HELPS)'/, `${file}.js must not build machine states`);
  }
});

test('npm scripts expose the drift check and CI runs it', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['check:demo'], 'node scripts/sync-demo.mjs --check');
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /npm run check:demo/);
});
