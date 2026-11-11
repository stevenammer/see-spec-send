import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';

test('redteam: a member cannot attribute reported evidence to another person', () => {
  const store = new Store();
  store.registerPerson('member');
  store.registerPerson('leader', { leader: true });
  store.registerPerson('steward');
  store.registerToken('run', { kind: 'run', item: 'item' });
  const put = (type, actor, body, idem) => store.append('item', {
    type, actor, at: '2026-11-11T00:00:00.000Z', ...body,
  }, { idem });

  put('checked', 'steward', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }, 'checked');
  put('specced', 'steward', { must: ['x'], how_we_know: ['x'], out_of_scope: [] }, 'spec');
  const specHash = store.read('item').context.specHash;
  put('approved', 'leader', { spec_hash: specHash, cap_usd: 0, quorum: 1 }, 'approved');
  put('tried', 'run', { approval: 1, spec_hash: specHash, artifact_hash: 'artifact' }, 'tried');

  assert.throws(() => put('helped', 'member', {
    artifact_hash: 'artifact',
    evidence: [{ url: 'https://attacker.example/evidence', claim: 'works', kind: 'reported', reported_by: 'leader' }],
  }, 'forged-reporter'), /reported_by.*actor|evidence.*actor/,
  'the event author must not be able to forge another person as its reporter');
});
