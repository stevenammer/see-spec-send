import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../scripts/watch-it-refuse.mjs';

test('the real server refuses the author, the approver and a made-up done, then reaches Helps', async () => {
  const { text, codes } = await run();
  assert.equal(codes.author, 409, 'the person who wrote the spec must be refused');
  assert.equal(codes.approver, 409, 'the leader who approved it must be refused');
  assert.equal(codes.done, 409, 'a made-up done event must be refused');
  assert.equal(codes.first, 201);
  assert.equal(codes.second, 201);
  assert.equal(codes.final, 'HELPS');
  const doc = readFileSync(new URL('../docs/WATCH_IT_REFUSE.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(text), 'docs/WATCH_IT_REFUSE.md must contain the current script output');
});
