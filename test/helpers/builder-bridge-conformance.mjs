import assert from 'node:assert/strict';

// Call with a fresh bridge factory backed by the same durable test transport.
// This is a baseline contract check, not proof of sandbox or metering safety.
export function checkStaticBridgeConformance(factory, request) {
  let bridge = factory();
  bridge.start(request); bridge.start(request);
  const ready = bridge.status(request.id);
  assert.equal(ready.state, 'ready');
  bridge = factory();
  assert.deepEqual(bridge.status(request.id), ready);
  assert.throws(() => bridge.start({ ...request, item: `${request.item}-changed` }));
  assert.equal(bridge.stop(request.id).state, 'stopped');
  assert.equal(factory().status(request.id).state, 'stopped');
  assert.throws(() => bridge.start({ ...request, item: `${request.item}-changed` }));
  const neverStarted = { ...request, id: 'e'.repeat(64) };
  assert.equal(bridge.stop(neverStarted.id).state, 'stopped');
  try { bridge.start(neverStarted); } catch {}
  assert.equal(factory().status(neverStarted.id).state, 'stopped');
}
