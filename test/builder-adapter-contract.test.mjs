import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { FakeAdapter } from '../worker/fake.js';
import { builtInBuilderRegistry, createBuilderRegistry, createBridgeAdapter, negotiateBuilder, STATIC_CAPABILITIES } from '../worker/adapter-contract.js';
import { checkStaticBridgeConformance } from './helpers/builder-bridge-conformance.mjs';
import { put, spec, approve } from './helpers/gateway-fixture.mjs';

const manifest = { version: 2, capabilities: [...STATIC_CAPABILITIES] };
const request = { id: 'f'.repeat(64), item: 'item', approval: 1, iteration: 0, spec_hash: 'a'.repeat(64), cap_micros: 0,
  spec: { must: ['One proof'], how_we_know: ['Visible'], out_of_scope: [] }, instructions: [{ instruction: 'Refine it', actor: 'private', source: 'private', mode: 'quoted' }] };

test('contract negotiates exact versions and capabilities before constructing adapters', () => {
  const registry = createBuilderRegistry(); let creates = 0;
  registry.register('custom', manifest, () => { creates++; return {}; });
  assert.throws(() => registry.select('custom', { version: 3 }), /invalid requested contract/);
  assert.throws(() => registry.select('custom', { capabilities: ['network'] }), /unknown requested capability/);
  assert.throws(() => registry.select('other'), /unknown profile/);
  assert.equal(creates, 0);
  assert.throws(() => negotiateBuilder({ version: 3, capabilities: [] }), /invalid version/);
  const limited = { version: 2, capabilities: ['static_html', 'approved_spec'] };
  assert.throws(() => negotiateBuilder(limited, { capabilities: ['adopted_instructions'] }), /missing capabilities/);
  const bridge = createBridgeAdapter({ start() {}, status() {}, stop() {} }, limited);
  assert.throws(() => bridge.start(request), /missing capabilities/);
});

test('trusted synthetic bridge enforces request and response profile and stop semantics', () => {
  const jobs = new Map(); let seen;
  const transport = {
    start(input) { seen = input; const old = jobs.get(input.id); if (old && JSON.stringify(old.input) !== JSON.stringify(input)) throw Error('id conflict'); if (!old) jobs.set(input.id, { input, state: 'ready' }); },
    status(id) { const job = jobs.get(id); return job ? (job.state === 'ready' ? { state: 'ready', html: '<!doctype html><html><body>OK</body></html>' } : { state: job.state }) : { state: 'missing' }; },
    stop(id) { const job = jobs.get(id) || {}; job.state = 'stopped'; jobs.set(id, job); return { state: 'stopped' }; },
  };
  const registry = createBuilderRegistry(); registry.register('own-agent', manifest, () => transport);
  checkStaticBridgeConformance(() => registry.select('own-agent', { capabilities: ['adopted_instructions'] }), request);
  jobs.clear();
  const bridge = registry.select('own-agent', { capabilities: ['adopted_instructions'] });
  bridge.start(request); bridge.start(request);
  assert.deepEqual(seen.instructions, [{ instruction: 'Refine it' }]); assert.ok(Object.isFrozen(seen.spec));
  assert.equal(bridge.status(request.id).state, 'ready');
  assert.throws(() => bridge.start({ ...request, item: 'other' }), /conflict/);
  assert.equal(bridge.stop(request.id).state, 'stopped'); assert.equal(bridge.status(request.id).state, 'stopped');
  assert.throws(() => bridge.start({ ...request, extra: true }), /invalid request field/);
  const bad = createBridgeAdapter({ ...transport, status: () => ({ state: 'ready', html: '<!doctype html><script>bad()</script>' }) }, manifest);
  assert.throws(() => bad.status(request.id), /static/);
  const malformed = createBridgeAdapter({ ...transport, status: () => ({ state: 'ready', html: '<!doctype html>', surprise: true }) }, manifest);
  assert.throws(() => malformed.status(request.id), /artifact response/);
});

test('real worker can use a registered synthetic bridge and retains delivery authority', () => {
  const store = new Store(); try {
    store.registerPerson('writer'); store.registerPerson('leader', { leader: true });
    put(store, 'checked', 'writer', { problem: 'Synthetic proof', looked: ['Existing options'], found: [], verdict: 'build_needed' });
    spec(store); approve(store);
    const registry = createBuilderRegistry(); registry.register('synthetic', manifest, () => new FakeAdapter(store));
    const worker = new Worker(store, registry.select('synthetic')); worker.reconcile();
    const run = store.db.prepare('SELECT * FROM runs').get();
    assert.equal(run.delivered, 1); assert.equal(store.events('item').filter(event => event.type === 'tried').length, 1);
    assert.equal(worker.deliver(run.id, '<script>late</script>'), false);
    assert.equal(store.events('item').filter(event => event.type === 'tried').length, 1);
  } finally { store.close(); }
});

test('built-in profiles select existing implementations and refuse unknown profiles', () => {
  const store = new Store(); try {
    const registry = builtInBuilderRegistry(store);
    assert.ok(registry.select('fixture') instanceof FakeAdapter);
    assert.throws(() => registry.select('external-command'), /unknown profile/);
    assert.throws(() => registry.select('fixture', { capabilities: ['shell'] }), /unknown requested capability/);
  } finally { store.close(); }
});
