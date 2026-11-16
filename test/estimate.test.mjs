import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEstimates, priorChargedRange } from '../knowledge/estimate.js';
import { initial, step } from '../core/machine.js';

test('estimate without a basis is labeled author judgment', () => {
  assert.deepEqual(normalizeEstimates([{ dimension: 'people_time', low: 1, high: 2, unit: 'hours', unknowns: [], alternatives: [] }])[0].basis,
    [{ kind: 'author_judgment', ref: 'No source recorded' }]);
});

test('estimate never sets or raises the approval cap', () => {
  const state = { ...initial(), rules: 3, phase: 'SPECCED', steward: 's', seeHash: 'see', specHash: 'spec', activePost: { id: 'spec:spec', kind: 'spec', version: 'spec' } };
  const outcome = step(state, { type: 'specced', actor: 's', see_hash: 'see', base_spec_hash: 'spec', body_hash: 'next', must: ['x'], how_we_know: ['y'], out_of_scope: [], assumptions: [], open_questions: [], post_id: 'spec:spec', post_version: 'spec', estimates: [{ dimension: 'build_spend', low: 0, high: 999999, unit: 'USD', basis: [{ kind: 'author_judgment', ref: 'guess' }], unknowns: [], alternatives: [] }] }, { kind: 'person' });
  assert.equal(outcome.context.capMicros, null);
});

test('fewer than three priors says too few prior builds', () => {
  assert.deepEqual(priorChargedRange([{ charged_micros: 3 }, { charged_micros: 5 }]), { status: 'too few prior builds', n: 2 });
});
