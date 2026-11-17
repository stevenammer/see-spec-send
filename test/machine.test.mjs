import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, step } from '../core/machine.js';

const person = { kind: 'person', leader: false };
const leader = { kind: 'person', leader: true };
const checked = { type: 'checked', actor: 's', problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' };

test('machine needs separately resolved authority', () => {
  assert.ok(step(initial(), checked, person).context);
  assert.ok(step(initial(), { ...checked, role: 'leader' }, person).context);
  assert.ok(step(initial(), checked).refusal);
  const one = step(initial(), checked, person).context;
  const spec = step(one, { type: 'specced', actor: 's', must: ['x'], how_we_know: ['x'], out_of_scope: [], body_hash: 'spec' }, person);
  assert.ok(spec.context);
  assert.ok(step(spec.context, { type: 'approved', actor: 's', spec_hash: 'spec', cap_usd: 1, quorum: 1 }, leader).refusal);
  const sending = step(spec.context, { type: 'approved', actor: 'l', spec_hash: 'spec', cap_usd: 1, quorum: 1 }, leader).context;
  assert.ok(step(sending, { type: 'tried', actor: 'r', artifact_hash: 'a', approval: 1, spec_hash: 'spec' }, { kind: 'run' }).context);
  const trying = step(sending, { type: 'tried', actor: 'r', artifact_hash: 'a', approval: 1, spec_hash: 'spec' }, { kind: 'run' }).context;
  assert.ok(step(trying, { type: 'helped', actor: 'm', artifact_hash: 'wrong' }, person).refusal);
  assert.ok(step(trying, { type: 'helped', actor: 's', artifact_hash: 'a' }, person).refusal);
  assert.deepEqual(step(sending, { type: 'specced', actor: 's', must: ['x'], how_we_know: ['x'], out_of_scope: [] }, person).effects,
    [{ kind: 'build.stop', reason: 'specced' }]);
});

test('a problem must be present and at most 2000 characters, whether a person checks it or a source reports it', () => {
  const source = { kind: 'source' };
  const seen = { type: 'seen', actor: 'src', problem: 'x', source_label: 'Help desk', honesty_label: 'reported' };
  assert.ok(step(initial(), seen, source).context, 'a plain reported problem is accepted');
  assert.ok(step(initial(), checked, person).context, 'a plain checked problem is accepted');
  for (const problem of ['', 'x'.repeat(2001), undefined, 42]) {
    assert.ok(step(initial(), { ...seen, problem }, source).refusal, `a reported problem of ${JSON.stringify(problem)?.slice(0, 12)} is refused`);
    assert.ok(step(initial(), { ...checked, problem }, person).refusal, `a checked problem of ${JSON.stringify(problem)?.slice(0, 12)} is refused`);
  }
  assert.ok(step(initial(), { ...seen, problem: 'x'.repeat(2000) }, source).context, 'exactly 2000 is accepted (reported)');
  assert.ok(step(initial(), { ...checked, problem: 'x'.repeat(2000) }, person).context, 'exactly 2000 is accepted (checked)');
});

test('a comment can anchor to the SPEC only while that SPEC still describes the current SEE', () => {
  const member = { kind: 'person', leader: false };
  const base = { ...initial(), rules: 2, phase: 'CHECKED', steward: 's', seeHash: 'see-2', specHash: 'spec-1' };
  const onSpec = { type: 'commented', actor: 'm', kind: 'comment', comment: 'about the spec', anchor_kind: 'spec', anchor_hash: 'spec-1' };
  assert.ok(step({ ...base, specSeeHash: 'see-2' }, onSpec, member).context, 'a SPEC written against the current SEE can be discussed');
  assert.ok(step({ ...base, specSeeHash: 'see-1' }, onSpec, member).refusal, 'a SPEC written against an older SEE is stale and cannot be');
  assert.ok(step({ ...base, specSeeHash: 'see-1' }, { ...onSpec, anchor_kind: 'see', anchor_hash: 'see-2' }, member).context, 'the current SEE can always be discussed');
});
