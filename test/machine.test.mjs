import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, step } from '../core/machine.js';

const person = { kind: 'person', leader: false };
const leader = { kind: 'person', leader: true };
const checked = { type: 'checked', actor: 's', looked: ['x'], found: [], verdict: 'build_needed' };

test('machine needs separately resolved authority', () => {
  assert.ok(step(initial(), checked, person).context);
  assert.ok(step(initial(), { ...checked, role: 'leader' }, person).context);
  assert.ok(step(initial(), checked).refusal);
  const one = step(initial(), checked, person).context;
  const spec = step(one, { type: 'specced', actor: 's', must: ['x'], how_we_know: ['x'], out_of_scope: [], body_hash: 'spec' }, person);
  assert.ok(spec.context);
  assert.ok(step(spec.context, { type: 'approved', actor: 's', spec_hash: 'spec', cap_usd: 1, quorum: 1 }, leader).refusal);
  const sending = step(spec.context, { type: 'approved', actor: 'l', spec_hash: 'spec', cap_usd: 1, quorum: 1 }, leader).context;
  assert.ok(step(sending, { type: 'tried', actor: 'r', artifact_hash: 'a' }, { kind: 'run' }).context);
  const trying = step(sending, { type: 'tried', actor: 'r', artifact_hash: 'a' }, { kind: 'run' }).context;
  assert.ok(step(trying, { type: 'helped', actor: 'm', artifact_hash: 'wrong' }, person).refusal);
  assert.deepEqual(step(sending, { type: 'specced', actor: 's', must: ['x'], how_we_know: ['x'], out_of_scope: [] }, person).effects,
    [{ kind: 'build.stop', reason: 'specced' }]);
});
