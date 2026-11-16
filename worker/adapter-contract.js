import { FakeAdapter } from './fake.js';
import { ContainerAdapter } from './container.js';
import { OpenCodeAdapter } from './opencode.js';
import { approvedBuildInput, validateHtml } from './builder/index.js';

// Version 2 adds a bounded source bundle. The fixture remains the default profile.
export const BUILDER_CONTRACT_VERSION = 2;
export const STATIC_CAPABILITIES = Object.freeze(['static_html', 'approved_spec', 'adopted_instructions', 'bundle']);
const capabilities = new Set(STATIC_CAPABILITIES);
const fail = message => { throw Error(`builder adapter incompatible: ${message}`); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const idPattern = /^[a-f0-9]{64}$/;

export function negotiateBuilder(manifest, requirements = {}) {
  if (!plain(manifest) || Object.keys(manifest).sort().join(',') !== 'capabilities,version'
      || manifest.version !== BUILDER_CONTRACT_VERSION || !Array.isArray(manifest.capabilities)
      || manifest.capabilities.some(value => typeof value !== 'string' || !capabilities.has(value))
      || new Set(manifest.capabilities).size !== manifest.capabilities.length) fail('invalid version or capability declaration');
  if (!plain(requirements) || Object.keys(requirements).some(key => !['version', 'capabilities'].includes(key))
      || (requirements.version ?? BUILDER_CONTRACT_VERSION) !== BUILDER_CONTRACT_VERSION
      || !Array.isArray(requirements.capabilities ?? [])) fail('invalid requested contract');
  const required = requirements.capabilities ?? [];
  if (required.some(value => typeof value !== 'string' || !capabilities.has(value))) fail('unknown requested capability');
  const missing = required.filter(value => !manifest.capabilities.includes(value));
  if (missing.length) fail(`missing capabilities: ${missing.join(', ')}`);
  return Object.freeze({ version: BUILDER_CONTRACT_VERSION, capabilities: Object.freeze([...manifest.capabilities]) });
}

function requestCopy(request) {
  if (!plain(request) || !idPattern.test(request.id || '') || typeof request.item !== 'string' || !request.item
      || !Number.isSafeInteger(request.approval) || request.approval < 1 || !idPattern.test(request.spec_hash || '')
      || !Number.isSafeInteger(request.cap_micros) || request.cap_micros < 0
      || (request.iteration !== undefined && (!Number.isSafeInteger(request.iteration) || request.iteration < 0))) fail('invalid run identity');
  if (Object.keys(request).some(key => !['id', 'item', 'approval', 'iteration', 'spec_hash', 'cap_micros', 'spec', 'instructions'].includes(key))) fail('invalid request field');
  const instructions = request.instructions ?? [];
  if (!Array.isArray(instructions) || instructions.some(row => !plain(row) || typeof row.instruction !== 'string')) fail('invalid adopted instructions');
  approvedBuildInput({ ...request.spec, ...(instructions.length ? { instructions: instructions.map(row => row.instruction) } : {}) });
  return freeze(JSON.parse(JSON.stringify({ ...request, instructions: instructions.map(row => ({ instruction: row.instruction })) })));
}

// The host supplies trusted synchronous transport code with host privileges.
// This wrapper validates the contract; it does not confine the transport or
// prevent it from bypassing sandbox, gateway or other external controls.
export function createBridgeAdapter(transport, manifest, requirements = {}) {
  const selected = negotiateBuilder(manifest, { ...requirements, capabilities: ['static_html', 'approved_spec', ...(requirements.capabilities || [])] });
  if (!plain(transport) || ['start', 'status', 'stop'].some(key => typeof transport[key] !== 'function')) fail('transport requires start, status and stop');
  const read = id => { if (!idPattern.test(id || '')) fail('invalid run id'); return id; };
  const observe = (result, stopping = false) => {
    if (!plain(result) || !['missing', 'running', 'ready', 'failed', 'stopped'].includes(result.state)) fail('invalid transport status');
    if (stopping && !['running', 'failed', 'stopped'].includes(result.state)) fail('invalid stop status');
    if (result.state === 'ready') {
      const keys = Object.keys(result).sort().join(',');
      if (keys === 'html,state') return { state: 'ready', html: validateHtml(result.html) };
      if (keys === 'bundle,state' && selected.capabilities.includes('bundle') && plain(result.bundle)) return { state: 'ready', bundle: freeze(JSON.parse(JSON.stringify(result.bundle))) };
      fail('invalid artifact response');
    }
    if (Object.keys(result).some(key => !['state', 'error'].includes(key)) || (result.error !== undefined && typeof result.error !== 'string')) fail('invalid status fields');
    return { state: result.state, ...(result.error !== undefined ? { error: result.error } : {}) };
  };
  return Object.freeze({ externalStart: true, modelOutput: true,
    start(request) {
      if (request?.instructions?.length && !selected.capabilities.includes('adopted_instructions')) fail('missing capabilities: adopted_instructions');
      const result = transport.start(requestCopy(request));
      if (result && typeof result.then === 'function') fail('start must be synchronous');
    },
    status(id) { return observe(transport.status(read(id))); },
    stop(id) { return observe(transport.stop(read(id)), true); },
  });
}

// Registration is trusted host configuration, never a user-supplied command.
function registryFor(builtins = []) {
  const entries = new Map(builtins.map(([name, manifest, factory]) => [name, { manifest: negotiateBuilder(manifest), factory, builtIn: true }]));
  return Object.freeze({
    register(name, manifest, factory) {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name) || entries.has(name) || typeof factory !== 'function') fail('invalid registration');
      entries.set(name, { manifest: negotiateBuilder(manifest), factory });
    },
    select(name, requirements = {}, options = {}) {
      const entry = entries.get(name); if (!entry) fail(`unknown profile: ${name}`);
      negotiateBuilder(entry.manifest, requirements);
      const adapter = entry.factory(options);
      return entry.builtIn ? adapter : createBridgeAdapter(adapter, entry.manifest, requirements);
    },
  });
}

export function createBuilderRegistry() { return registryFor(); }

export function builtInBuilderRegistry(store) {
  const manifest = { version: 2, capabilities: STATIC_CAPABILITIES };
  return registryFor([
    ['fixture', manifest, () => new FakeAdapter(store)],
    ['container', manifest, options => {
      if (Object.keys(options).some(key => !['gatewaySocket', 'root', 'providerEnv'].includes(key))) fail('unsupported container option');
      return new ContainerAdapter(store, options);
    }],
    ['opencode', manifest, options => {
      if (Object.keys(options).some(key => !['gatewaySocket', 'root', 'imageFile', 'providerMode'].includes(key))) fail('unsupported opencode option');
      return new OpenCodeAdapter(store, options);
    }],
  ]);
}
