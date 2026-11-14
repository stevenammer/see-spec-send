import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { buildPacket } from '../core/packet.js';
import { effortPrompt } from '../effort/prompt.js';
import { itemPage } from '../app/pages.js';

const at = n => `2026-11-14T00:00:${String(n).padStart(2, '0')}.000Z`;
const append = (store, item, event, n) => store.append(item, { ...event, at: at(n) }, { idem: `${item}-${n}` });
const people = store => { store.registerPerson('op'); store.registerPerson('member'); store.registerPerson('leader', { leader: true }); };
const ready = store => {
  people(store);
  append(store, 'i', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see = store.read('i').context.seeHash;
  append(store, 'i', { type: 'specced', actor: 'op', see_hash: see, must: ['one'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec = store.read('i').context.specHash;
  const packet = store.putArtifact('i', JSON.stringify({ specHash: spec }));
  append(store, 'i', { type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet }, 3);
  append(store, 'i', { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'A leader recorded a real reason.', cap_usd: 1, quorum: 1 }, 4);
  return { see, spec };
};

test('R stale SEE revision stops the run, supersedes its artifact, and a check-in does not', () => {
  const store = new Store(); const { see, spec } = ready(store);
  const run = { id: 'r0', item: 'i', approval: 1, iteration: 0, spec_hash: spec, status: 'active', delivered: 0 };
  store.db.prepare("INSERT INTO runs(id,item,approval,iteration,spec_hash,run_actor,gateway_actor,status,delivered) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(run.id, run.item, run.approval, run.iteration, run.spec_hash, 'run-token', 'gate-token', run.status, run.delivered);
  store.registerToken('run-token', { kind: 'run', item: 'i' }); store.registerToken('gate-token', { kind: 'gateway', item: 'i' });
  append(store, 'i', { type: 'checked_in', actor: 'member', note: 'Still checking the details.' }, 5);
  assert.equal(store.read('i').state, 'SENDING');
  append(store, 'i', { type: 'revised', actor: 'op', text: 'A materially revised SEE', base_hash: see }, 6);
  assert.equal(store.read('i').context.superseded, true);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get('r0').status, 'stop_requested');
  assert.throws(() => append(store, 'i', { type: 'tried', actor: 'run-token', approval: 1, spec_hash: spec, iteration: 0, artifact_hash: 'a'.repeat(64) }, 7), /stopped|not allowed/);
});

test('R reply parent must bind both thread kind and exact version hash', () => {
  const store = new Store(); people(store);
  append(store, 'i', { type: 'posted', actor: 'op', original: 'Original', rules: 2 }, 1);
  const see = store.read('i').context.seeHash;
  append(store, 'i', { type: 'commented', actor: 'member', comment: 'v1 thought', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const parent = store.events('i').at(-1).body_hash;
  append(store, 'i', { type: 'revised', actor: 'op', text: 'Version two', base_hash: see }, 3);
  const v2 = store.read('i').context.seeHash;
  assert.throws(() => append(store, 'i', { type: 'commented', actor: 'op', comment: 'This cannot masquerade as v2 reply', kind: 'comment', anchor_kind: 'see', anchor_hash: v2, parent }, 4), /parent anchor does not match/);
});

test('R fork keeps the stated reason and packet derives revision credits', () => {
  const store = new Store(); people(store);
  append(store, 'parent', { type: 'posted', actor: 'op', original: 'Original', rules: 2 }, 1);
  const see = store.read('parent').context.seeHash;
  append(store, 'parent', { type: 'commented', actor: 'member', comment: 'Use the exact phrase', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const comment = store.events('parent').at(-1).body_hash;
  append(store, 'parent', { type: 'revised', actor: 'op', text: 'Original. Use the exact phrase', base_hash: see, credits: [{ comment, mode: 'quoted' }] }, 3);
  const row = store.eventRows('parent').at(-1);
  append(store, 'fork', { type: 'forked', actor: 'member', original: 'Forked', rules: 2, reason: 'This needs a different local workflow.', parent: { item: 'parent', seq: row.seq, hash: row.hash } }, 4);
  assert.equal(store.events('fork')[0].reason, 'This needs a different local workflow.');
  const packet = buildPacket({ original: 'Original', see: 'Original. Use the exact phrase', spec: { hash: 's' },
    credits: [{ comment, mode: 'quoted' }], comments: store.events('parent') });
  assert.deepEqual(packet.credits[0], { comment, mode: 'quoted', author: 'member', text: 'Use the exact phrase' });
});

test('R stale worker completion is a handled false result, not an exception', () => {
  const store = new Store(); const { see, spec } = ready(store);
  const worker = new Worker(store);
  const runToken = 'run-token'; const gatewayToken = 'gateway-token';
  store.registerToken(runToken, { kind: 'run', item: 'i' }); store.registerToken(gatewayToken, { kind: 'gateway', item: 'i' });
  store.db.prepare("INSERT INTO runs(id,item,approval,iteration,spec_hash,run_actor,gateway_actor,status,delivered) VALUES(?,?,?,?,?,?,?,?,?)")
    .run('late', 'i', 1, 0, spec, runToken, gatewayToken, 'active', 0);
  append(store, 'i', { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: 'Try another direction' }, 5);
  assert.equal(worker.deliver('late', '<p>late</p>'), false);
  assert.equal(store.read('i').context.iteration, 1);
});

test('R SPEC inclusion is version-bound and Effort prompt omits old thread entries honestly', () => {
  const store = new Store(); const { see, spec } = ready(store);
  append(store, 'i', { type: 'commented', actor: 'member', comment: 'Add the caller name', kind: 'comment', anchor_kind: 'spec', anchor_hash: spec }, 5);
  const credit = store.events('i').at(-1).body_hash;
  append(store, 'i', { type: 'specced', actor: 'op', see_hash: see, base_spec_hash: spec, must: ['Add the caller name'], how_we_know: ['test'], out_of_scope: [], credits: [{ comment: credit, mode: 'quoted' }], }, 6);
  const next = store.read('i').context.specHash;
  assert.notEqual(next, spec);
  assert.throws(() => append(store, 'i', { type: 'specced', actor: 'op', see_hash: see, base_spec_hash: spec, must: ['stale'], how_we_know: ['test'], out_of_scope: [] }, 7), /not allowed/);
  const prompt = JSON.parse(effortPrompt('Original', Array.from({ length: 30 }, (_, n) => ({ comment: `reply ${n}` }))).input);
  assert.equal(prompt.thread.length, 20);
  assert.equal(prompt.omitted_comments, 10);
});

test('R reassignment needs the steward\'s recorded consent or fourteen days of event inactivity', () => {
  const store = new Store(); people(store);
  const stamp = day => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const put = (event, day) => store.append('i', { ...event, at: stamp(day) }, { idem: `reassign-${day}-${event.type}` });
  put({ type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  assert.throws(() => put({ type: 'steward_changed', actor: 'leader', steward: 'member', reason: 'The work needs a new steward.' }, 14), /consent|inactive/);
  put({ type: 'checked_in', actor: 'op', note: 'I consent to this handoff.', consent: true }, 14);
  put({ type: 'steward_changed', actor: 'leader', steward: 'member', reason: 'The work needs a new steward.' }, 15);
  assert.equal(store.read('i').context.originator, 'op');
  assert.equal(store.read('i').context.steward, 'member');
  assert.ok(store.read('i').context.authors.includes('member'));
  assert.ok(store.read('i').context.ineligibleHelpers.includes('member'));

  const inactive = new Store(); people(inactive);
  const old = (event, day) => inactive.append('old', { ...event, at: stamp(day) }, { idem: `old-${day}-${event.type}` });
  old({ type: 'posted', actor: 'op', original: 'Old SEE', rules: 2 }, 1);
  old({ type: 'steward_changed', actor: 'leader', steward: 'member', reason: 'No activity from the original steward.' }, 15);
  assert.equal(inactive.read('old').context.steward, 'member');
});

test('R a post reserves an honest Effort slot before a person comments, and keeps it on refresh', () => {
  const store = new Store(); people(store);
  append(store, 'i', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see = store.read('i').context.seeHash;
  append(store, 'i', { type: 'commented', actor: 'member', comment: 'A person can comment now.', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const item = { id: 'i', ...store.read('i'), effort: store.db.prepare('SELECT kind,state,last_error FROM effort_jobs WHERE item=?').all('i') };
  const first = itemPage(item, store.events('i'), 'member', false);
  const refresh = itemPage(item, store.events('i'), 'member', false);
  assert.match(first, /Effort: see_first is thinking/);
  assert.match(first, /A person can comment now/);
  assert.equal(first, refresh);
  item.effort[0].state = 'failed';
  assert.match(itemPage(item, store.events('i'), 'member', false), /Effort: see_first is unavailable, retrying/);
  item.effort[0].state = 'done';
  assert.match(itemPage(item, store.events('i'), 'member', false), /Effort: see_first is answered/);
});

test('R quoted credit is refused unless the new SEE contains the exact source words', () => {
  const store = new Store(); people(store);
  append(store, 'i', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see = store.read('i').context.seeHash;
  append(store, 'i', { type: 'commented', actor: 'member', comment: 'Use the caller name exactly.', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const credit = store.events('i').at(-1).body_hash;
  assert.throws(() => append(store, 'i', { type: 'revised', actor: 'op', text: 'Use their name.', base_hash: see, credits: [{ comment: credit, mode: 'quoted' }] }, 3), /verbatim/);
});
