import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestFor } from '../eval/builder/judge.mjs';

test('the judge manifest skips symlinks so a builder cannot pull a host file into the bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-judge-'));
  try {
    const bundle = join(dir, 'bundle'), outside = join(dir, 'outside.txt');
    mkdirSync(join(bundle, 'sub'), { recursive: true });
    writeFileSync(join(bundle, 'index.html'), '<p>hi</p>');
    writeFileSync(join(bundle, 'sub', 'a.js'), 'x');
    writeFileSync(outside, 'host secret');
    symlinkSync(outside, join(bundle, 'leak.txt'));
    symlinkSync(join(dir), join(bundle, 'loop'));
    assert.deepEqual(manifestFor(bundle).files.map(f => f.path), ['index.html', 'sub/a.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
