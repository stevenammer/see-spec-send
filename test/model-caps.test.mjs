import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_SYSTEM } from '../effort/prompt.js';
import { ANALYSIS_LIMITS } from '../gateway/analysis.js';
import { EFFORT_LIMITS } from '../gateway/effort.js';

// Findings from the model evaluation (docs/MODEL_EVAL.md), pinned so they are not quietly undone.

test('an ask-the-organization answer may be long enough for a thorough model to finish', () => {
  // Claude Haiku 4.5 writes 2,000 to 3,000 tokens for these answers. At the old 1,024 cap every answer was cut off
  // mid-JSON and refused, so the feature silently fell back to sources only.
  assert.ok(ANALYSIS_LIMITS.output_tokens >= 4096, `analysis output cap is ${ANALYSIS_LIMITS.output_tokens}`);
});

test('the Effort reply cap stays small, because replies are meant to be short', () => {
  assert.ok(EFFORT_LIMITS.output_tokens <= 256);
});

test('Effort is told how to write: plain, short, no jargon, no invention, check what exists first', () => {
  assert.match(EFFORT_SYSTEM, /plain text only, with no markdown/);
  assert.match(EFFORT_SYSTEM, /about 80 words or fewer/);
  assert.match(EFFORT_SYSTEM, /do not write "authority order", "triggering comment", or "current SEE"/);
  assert.match(EFFORT_SYSTEM, /If the post does not say something, say so in one plain sentence and ask one question/);
  assert.match(EFFORT_SYSTEM, /Do not invent a team, number, process, or cause/);
  assert.match(EFFORT_SYSTEM, /say to check that first, before anyone builds anything/);
  assert.match(EFFORT_SYSTEM, /say plainly that you cannot and that people decide those things/);
});
