import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';

const approvedAt = Date.parse('2026-11-14T12:00:00.000Z');
const deadline = approvedAt + 60_000;
function setup(t, { externalStart = false, onStatus, approve = true } = {}) {
  const store = new Store();
  t.after(() => store.close());
  store.registerPerson('op');
  store.registerPerson('leader', { leader: true });
  let sequence = 0;
  const append = data => store.append('leash', { ...data, at: new Date(approvedAt).toISOString() }, { idem: `leash:${sequence++}` });
  append({ type: 'posted', actor: 'op', original: 'Keep the transfer note visible.', rules: 2 });
  append({ type: 'specced', actor: 'op', see_hash: store.read('leash').context.seeHash,
    must: ['Show the note'], how_we_know: ['The note survives a transfer'], out_of_scope: [] });
  const spec_hash = store.read('leash').context.specHash;
  const packet_hash = store.putArtifact('leash', JSON.stringify({ specHash: spec_hash }));
  append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
  if (approve) append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, cap_usd: 0, quorum: 1,
    reason: 'A bounded transfer-note experiment is useful.', window_minutes: 1,
    max_iterations: 1, expires_at: new Date(deadline).toISOString() });
  const starts = []; const stops = [];
  const adapter = {
    externalStart,
    start: request => starts.push(request),
    status: id => onStatus?.(id) || { state: 'running' },
    stop: id => { stops.push(id); return { state: 'stopped' }; },
  };
  let now = approvedAt;
  const worker = new Worker(store, adapter, { clock: () => now });
  return { store, worker, starts, stops, append, spec_hash, packet_hash, setNow: value => { now = value; } };
}

test('F3 worker never starts an approval at or beyond its fixed deadline', t => {
  const fixture = setup(t);
  fixture.setNow(deadline);
  fixture.worker.reconcile();
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.store.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
});

test('F3 worker stops active work at deadline, records failure once, and never restarts', t => {
  const fixture = setup(t);
  fixture.setNow(deadline - 1);
  fixture.worker.reconcile();
  assert.equal(fixture.starts.length, 1);
  fixture.setNow(deadline);
  fixture.worker.reconcile();
  fixture.worker.reconcile();
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.stops.length, 1);
  assert.equal(fixture.store.db.prepare('SELECT status FROM runs').get().status, 'stopped');
  assert.equal(fixture.store.read('leash').state, 'SPECCED');
  assert.equal(fixture.store.events('leash').filter(row => row.type === 'failed').length, 1);
  assert.deepEqual(fixture.store.verifyAll(), [{ item: 'leash', ok: true }]);
});

test('F3 deadline reached while adapter status returns ready refuses artifact and stops cleanly', t => {
  let fixture;
  fixture = setup(t, { onStatus: () => {
    fixture.setNow(deadline);
    return { state: 'ready', html: '<p>Too late</p>' };
  } });
  assert.doesNotThrow(() => fixture.worker.reconcile());
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.stops.length, 1);
  assert.equal(fixture.store.events('leash').filter(row => row.type === 'tried').length, 0);
  assert.equal(fixture.store.read('leash').state, 'SPECCED');
});

test('F3 direct late delivery stops the adapter instead of throwing or publishing', t => {
  const fixture = setup(t);
  fixture.worker.reconcile();
  const run = fixture.store.db.prepare('SELECT * FROM runs').get();
  fixture.setNow(deadline);
  assert.equal(fixture.worker.deliver(run.id, '<p>Late completion</p>'), false);
  assert.equal(fixture.stops.length, 1);
  assert.equal(fixture.store.db.prepare('SELECT delivered,status FROM runs').get().delivered, 0);
  assert.equal(fixture.store.read('leash').context.artifact, null);
});

test('F3 external adapter is checked again after releasing the worker lock', t => {
  const fixture = setup(t, { externalStart: true });
  let clockCalls = 0;
  fixture.worker.clock = () => ++clockCalls < 3 ? deadline - 1 : deadline;
  fixture.worker.reconcile();
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.stops.length, 1);
  assert.equal(fixture.store.read('leash').state, 'SPECCED');
});


test('F3 Not building reasons are required and its decision cannot be erased through either store path', t => {
  const fixture = setup(t, { approve: false });
  const { store, append, spec_hash, packet_hash } = fixture;
  assert.throws(() => append({ type: 'not_built', actor: 'leader', spec_hash, packet_hash, reason: 'No' }), /not allowed/);
  append({ type: 'not_built', actor: 'leader', spec_hash, packet_hash, reason: 'Use the existing transfer note view first.' });
  const decision = store.events('leash').at(-1).body_hash;
  assert.throws(() => store.erase('leash', decision, 'leader', new Date(approvedAt).toISOString()), /decision records/);
  assert.throws(() => append({ type: 'erased', actor: 'leader', body_hash: decision, redacted_hash: 'a'.repeat(64) }), /decision records/);
});

test('F3 explicit expiry cannot extend the approved duration and missing expiry is derived', t => {
  const { store, append, spec_hash, packet_hash } = setup(t, { approve: false });
  const decision = { type: 'approved', actor: 'leader', spec_hash, packet_hash, cap_usd: 0, quorum: 1,
    reason: 'A one minute experiment is all that is authorized.', max_iterations: 1, window_minutes: 1 };
  assert.throws(() => append({ ...decision, expires_at: new Date(deadline + 60_000).toISOString() }), /expiry|not allowed/);
  append(decision);
  assert.equal(store.read('leash').context.leash.expiresAt, new Date(deadline).toISOString());
});

test('F3 research packet covers all six fixed source categories without implying a search ran', async () => {
  const { buildPacket } = await import('../core/packet.js');
  const packet = buildPacket({ original: 'Transfer notes', see: 'Transfer notes', spec: { hash: 'spec' } });
  assert.deepEqual(Object.keys(packet.researched), [
    'internal tools and licenses', 'internal prior work', 'configuration options',
    'open source', 'commercial options', 'process change',
  ]);
  assert.ok(Object.values(packet.researched).every(source => source.status === 'not connected' && source.finding === 'nothing checked'));
});
