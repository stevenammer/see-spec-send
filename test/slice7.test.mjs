import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSandbox } from '../worker/fake-sandbox.js';
import { defaultBuilderPolicy, validateBuilderPolicy } from '../worker/policy.js';
test('fake sandbox refuses escape and egress attempts and fires the emergency kill', () => {
  const kills = []; const sandbox = new FakeSandbox({ kill: reason => kills.push(reason) });
  for (const kind of ['egress', 'host_mount', 'cross_run_read', 'raw_socket', 'over_time', 'over_memory']) assert.deepEqual(sandbox.attempt({ kind }), { allowed: false, killed: true, reason: 'builder policy violation' });
  assert.equal(sandbox.killed, true); assert.equal(kills.length, 6); assert.deepEqual(defaultBuilderPolicy.egress, []);
  assert.throws(() => validateBuilderPolicy({ ...defaultBuilderPolicy, egress: ['https://example.test'] }), /egress/);
});
