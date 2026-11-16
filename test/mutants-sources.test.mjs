import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A mutant whose target text no longer exists silently tests nothing, or crashes the nightly run. Every refactor that
// moves code a mutant points at must update the mutant, and this test is what makes that impossible to forget.
for (const script of ['scripts/mutate-new.mjs', 'scripts/mutate-check.mjs']) {
  test(`every mutant in ${script} still matches real source`, () => {
    const run = spawnSync(process.execPath, [script, '--check-sources'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stderr.split('\n').find(line => /mutant source missing/.test(line)) || run.stderr.slice(0, 300)}`);
    assert.match(run.stdout, /^OK \d+ mutant find strings found/);
  });
}
