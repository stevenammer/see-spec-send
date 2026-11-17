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

test('R a SEE revision after a try is delivered supersedes it, so it cannot collect Helps', () => {
  const store = new Store(); const { see, spec } = ready(store);
  store.db.prepare("INSERT INTO runs(id,item,approval,iteration,spec_hash,run_actor,gateway_actor,status,delivered) VALUES(?,?,?,?,?,?,?,?,?)")
    .run('r1', 'i', 1, 0, spec, 'run-token', 'gate-token', 'active', 0);
  store.registerToken('run-token', { kind: 'run', item: 'i' }); store.registerToken('gate-token', { kind: 'gateway', item: 'i' });
  const artifact = store.putArtifact('i', '<p>try</p>');
  append(store, 'i', { type: 'tried', actor: 'run-token', approval: 1, spec_hash: spec, iteration: 0, artifact_hash: artifact, model_output: false }, 5);
  assert.equal(store.read('i').state, 'TRYING');
  // A comment on the try does not touch it; a revision of the SEE does.
  append(store, 'i', { type: 'revised', actor: 'op', text: 'The problem is different now', base_hash: see }, 6);
  assert.equal(store.read('i').state, 'SPECCED');
  assert.equal(store.read('i').context.superseded, true);
  assert.equal(store.read('i').context.supersededArtifact, artifact);
  assert.throws(() => append(store, 'i', { type: 'helped', actor: 'member', artifact_hash: artifact }, 7), /not allowed/);
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
  // The stale run is retired, not left active to be retried, and nothing was delivered for it.
  assert.equal(store.db.prepare("SELECT status FROM runs WHERE id='late'").get().status, 'stopped');
  assert.equal(store.db.prepare("SELECT delivered FROM runs WHERE id='late'").get().delivered, 0);
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
  assert.match(first, /Effort \(the AI\), first reply to the SEE: waiting to start/);
  assert.match(first, /A person can comment now/);
  assert.equal(first, refresh);
  item.effort[0].state = 'failed';
  assert.match(itemPage(item, store.events('i'), 'member', false), /Effort \(the AI\), first reply to the SEE: unavailable, retries exhausted/);
  item.effort[0].state = 'done';
  assert.match(itemPage(item, store.events('i'), 'member', false), /Effort \(the AI\), first reply to the SEE: replied/);
});

test('R quoted credit is refused unless the new SEE contains the exact source words', () => {
  const store = new Store(); people(store);
  append(store, 'i', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see = store.read('i').context.seeHash;
  append(store, 'i', { type: 'commented', actor: 'member', comment: 'Use the caller name exactly.', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const credit = store.events('i').at(-1).body_hash;
  assert.throws(() => append(store, 'i', { type: 'revised', actor: 'op', text: 'Use their name.', base_hash: see, credits: [{ comment: credit, mode: 'quoted' }] }, 3), /verbatim/);
});

// The fork route must store the reason the person typed (the unit test above appends events directly).
test('R the fork route stores the reason and shows it with the parent link', async () => {
  const { Readable } = await import('node:stream');
  const { Auth } = await import('../app/auth.js');
  const { createHandler } = await import('../app/http.js');
  class Res { constructor() { this.headers = {}; this.status = 200; this.text = ''; } setHeader(k, v) { this.headers[k.toLowerCase()] = v; } writeHead(c, h = {}) { this.status = c; Object.assign(this.headers, h); } end(v = '') { this.text += v; } }
  const call = async (handler, method, path, input, headers = {}) => {
    const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path;
    req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = new Res(); await handler(req, res); let body = null; try { body = JSON.parse(res.text); } catch {}
    return { status: res.status, headers: res.headers, text: res.text, body };
  };
  const store = new Store(); const auth = new Auth(store); const handler = createHandler({ store, auth, secure: false, origin: 'http://127.0.0.1' });
  await auth.createUser('olive', 'Olive-long-password-9x', false); await auth.createUser('maya', 'Maya-long-password-9x', false);
  const login = async (id, password) => { const r = await call(handler, 'POST', '/api/login', { id, password }); return { cookie: r.headers['set-cookie'].split(';')[0], origin: 'http://127.0.0.1', 'x-csrf-token': r.body.csrf }; };
  const olive = await login('olive', 'Olive-long-password-9x'); const maya = await login('maya', 'Maya-long-password-9x');
  const made = await call(handler, 'POST', '/api/items', { original: 'Callers lose context during transfer.' }, olive);
  assert.equal(made.status, 201);
  const itemId = made.body.id;
  const seeHash = store.read(itemId).context.seeHash;
  const active = store.read(itemId).context.activePost;
  store.append(itemId, { type: 'commented', actor: 'maya', comment: 'We need a different local workflow.', kind: 'alternative', anchor_kind: 'see', anchor_hash: seeHash,
    post_id: active.id, post_version: active.version, at: new Date().toISOString() }, { idem: 'maya-alt' });
  store.append(itemId, { type: 'specced', actor: 'olive', post_id: store.read(itemId).context.activePost.id, post_version: store.read(itemId).context.activePost.version, see_hash: seeHash, must: ['Keep context'], how_we_know: ['The next agent can see it'], out_of_scope: [], at: new Date().toISOString() }, { idem: 'status-spec' });
  for (const [state, label] of [['queued', 'waiting to start'], ['running', 'thinking'], ['blocked', 'blocked, not retrying'], ['failed', 'unavailable, retries exhausted']]) {
    store.db.prepare('UPDATE effort_jobs SET state=? WHERE item=?').run(state, itemId);
    const seePage = await call(handler, 'GET', `/items/${itemId}`, undefined, olive);
    const spec = await call(handler, 'GET', `/items/${itemId}/spec`, undefined, olive);
    assert.equal(seePage.status, 200); assert.equal(spec.status, 200);
    assert.ok(seePage.text.includes(`Effort (the AI), first reply to the SEE: ${label}`));
    assert.ok(spec.text.includes(`Effort (the AI), SPEC draft: ${label}`));
    assert.ok(!spec.text.includes('Effort (the AI), first reply to the SEE'));
  }
  const forked = await call(handler, 'POST', `/api/items/${made.body.id}/fork`, { reason: 'Our team needs a different local workflow.' }, maya);
  assert.equal(forked.status, 201);
  assert.equal(store.events(forked.body.id)[0].reason, 'Our team needs a different local workflow.');
  const page = await call(handler, 'GET', `/items/${forked.body.id}`, undefined, maya);
  assert.match(page.text, /Our team needs a different local workflow/);
});
