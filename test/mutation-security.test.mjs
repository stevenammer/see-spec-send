import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, step } from '../core/machine.js';
import { defaultBuilderPolicy, enforceBuilderAttempt } from '../worker/policy.js';
import { FakeOidcProvider, OidcLogin } from '../app/oidc.js';

const steward = { kind: 'person', leader: false };
const member = { kind: 'person', leader: false };
const leader = { kind: 'person', leader: true };
const specced = { ...initial(), phase: 'SPECCED', steward: 'steward', specHash: 'approved-spec' };
const approval = actor => ({ type: 'approved', actor, spec_hash: 'approved-spec', cap_usd: 1, quorum: 1 });

test('security mutation: approval needs a leader who is not the steward', () => {
  assert.ok(step(specced, approval('member'), member).refusal, 'a non-leader cannot approve');
  assert.ok(step(specced, approval('steward'), leader).refusal, 'the steward cannot approve their own spec');
  assert.equal(step(specced, approval('leader'), leader).state, 'SENDING');
});

test('security mutation: an attempted builder egress is denied and kills the run', () => {
  const kills = [];
  assert.deepEqual(enforceBuilderAttempt(defaultBuilderPolicy, { kind: 'egress' }, reason => kills.push(reason)), {
    allowed: false, killed: true, reason: 'builder policy violation',
  });
  assert.deepEqual(kills, ['builder policy violation: egress']);
});

test('security mutation: comments stay bound to the current artifact', () => {
  const state = { ...initial(), phase: 'TRYING', specHash: 'spec', artifact: 'current-artifact' };
  const result = step(state, {
    type: 'commented', actor: 'member', comment: 'this was for an older artifact',
    anchor_kind: 'artifact', anchor_hash: 'older-artifact',
  }, member);
  assert.ok(result.refusal, 'a comment anchored to another artifact is refused');
});

test('security mutation: OIDC redirect URI must be a clean HTTPS URL', () => {
  const provider = new FakeOidcProvider();
  const config = provider.configuration('http://localhost/callback');
  assert.throws(() => new OidcLogin(config), /redirect URI.*clean HTTPS/);
});
