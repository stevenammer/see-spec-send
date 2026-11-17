// Builder evaluation. Today it does the part that has to come first: prove the judge itself works.
//   PLAYWRIGHT_DIR=/path/to/node_modules node scripts/builder-eval.mjs --selftest
// For each task it judges a hand-written good bundle (must pass every check, and pass the host's own bundle validator)
// and a deliberately broken one (must fail at least one check). A judge that can't tell those apart proves nothing
// about a model's build. Run mode (a real builder and model) is added on top of this.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tasks } from '../eval/builder/tasks.mjs';
import { judgeBundle, manifestFor } from '../eval/builder/judge.mjs';
import { validateBundle } from '../worker/bundle.js';

function write(root, files) { for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); } }

async function selftest() {
  let bad = 0;
  for (const task of tasks) {
    const good = mkdtempSync(join(tmpdir(), `sss-judge-${task.id}-good-`)); write(good, task.oracle);
    try { validateBundle(good, manifestFor(good)); } catch (error) { console.log(`FAIL ${task.id}: the good bundle is not shippable by the host validator (${error.message})`); bad += 1; }
    const goodResult = await judgeBundle(good, task);
    if (!goodResult.ok) { console.log(`FAIL ${task.id}: the good bundle failed: ${goodResult.checks.filter(c => !c.ok).map(c => c.name).join('; ')}`); bad += 1; }
    const [file, from, to] = task.broken.patch;
    if (!task.oracle[file].includes(from)) { console.log(`FAIL ${task.id}: the break does not apply`); bad += 1; continue; }
    const broken = mkdtempSync(join(tmpdir(), `sss-judge-${task.id}-bad-`)); write(broken, { ...task.oracle, [file]: task.oracle[file].replace(from, to) });
    const brokenResult = await judgeBundle(broken, task);
    if (brokenResult.ok) { console.log(`FAIL ${task.id}: the broken bundle passed every check`); bad += 1; }
    console.log(`${task.id}: good ${goodResult.passed}/${goodResult.total}, broken ${brokenResult.passed}/${brokenResult.total} (caught by: ${brokenResult.checks.filter(c => !c.ok).map(c => c.name).join('; ')})`);
  }
  if (bad) { console.log(`${bad} problem(s)`); process.exit(1); }
  console.log('the judge tells good from broken on every task');
}

if (process.argv.includes('--selftest')) await selftest();
else { console.error('use --selftest (run mode comes next)'); process.exit(2); }
