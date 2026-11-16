import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { itemPage } from '../app/pages.js';
import { Readable } from 'node:stream';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

const stamp = '2026-11-15T12:00:00.000Z';
function setup(t, rules = 3) {
  const s = new Store(); t.after(() => s.close());
  s.registerPerson('op'); s.registerPerson('member'); s.registerPerson('leader', { leader: true });
  let n = 0;
  const append = event => s.append('item', { ...event, at: stamp }, { idem: `event-${++n}` });
  append({ type: 'posted', actor: 'op', original: 'A handoff loses the caller note.', rules });
  const binding = () => ({ post_id: s.read('item').context.activePost?.id, post_version: s.read('item').context.activePost?.version });
  const see = s.read('item').context.seeHash;
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep the caller note'], how_we_know: ['The next person can find it'], out_of_scope: [], ...binding() });
  const spec = s.read('item').context.specHash, packet = s.putArtifact('item', JSON.stringify({ specHash: spec }));
  append({ type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet, ...binding() });
  return { s, append, binding, spec, packet };
}

test('SEND disposition is attributable, exact-packet-bound, branchable, and replayable', t => {
  const { s, append, binding, spec, packet } = setup(t);
  const reviewPage = itemPage({ id: 'item', ...s.read('item'), packet: s.artifact('item', packet) }, s.events('item'), 'leader', true);
  assert.match(reviewPage, /Record another decision/); assert.match(reviewPage, /Return for revision/);
  assert.match(reviewPage, /Approve bounded work/); assert.match(reviewPage, /Re-enter your password/);
  const event = { type: 'decided', disposition: 'defer', reason_code: 'dependency_outstanding',
    reason: 'Wait for the service owner to confirm the existing handoff.', metadata: { owner: 'service-owner', review_by: '2026-12-01', trigger: 'service owner confirms the handoff' },
    spec_hash: spec, packet_hash: packet, ...binding() };
  assert.throws(() => append({ ...event, actor: 'op' }), /not allowed/, 'an author cannot decide their own SEND');
  assert.throws(() => append({ ...event, actor: 'leader', packet_hash: '0'.repeat(64) }), /not allowed/, 'decision must bind the exact packet');
  assert.throws(() => append({ ...event, actor: 'leader', metadata: { owner: 'service-owner' } }), /not allowed/, 'defer needs either a date or trigger');
  assert.throws(() => append({ ...event, actor: 'leader', metadata: { owner: 'service-owner', review_by: '2026-02-30' } }), /not allowed/, 'review date must be a real calendar date');
  append({ ...event, actor: 'leader' });
  const state = s.read('item');
  assert.equal(state.context.decided.disposition, 'defer');
  assert.equal(state.context.decided.packetHash, packet);
  assert.equal(state.context.decided.metadata.trigger, 'service owner confirms the handoff');
  assert.equal(state.context.decided.metadata.review_by, '2026-12-01');
  assert.equal(state.context.activePost, null, 'a non-approval freezes the submitted post without creating work authority');
  assert.equal(state.context.approval, 0);
  const sendPost = s.db.prepare("SELECT * FROM stage_posts WHERE kind='send'").get();
  const decisionPost = s.db.prepare('SELECT * FROM stage_posts WHERE post_id=?').get(sendPost.successor_post_id);
  assert.equal(decisionPost.kind, 'decision');
  assert.equal(decisionPost.successor_post_id, null);
  const page = itemPage({ id: 'item', ...state }, s.events('item'), 'member', false);
  assert.match(page, /Decision record/); assert.match(page, />Defer</); assert.match(page, /service owner confirms/);
  assert.throws(() => s.erase('item', s.events('item').at(-1).body_hash, 'leader', stamp), /decision records/);
  assert.ok(s.verifyAll().every(row => row.ok));
  s.rebuild(); assert.ok(s.verifyAll().every(row => row.ok));
  assert.ok(s.forkPoint('item', { kind: 'snapshot', post_id: sendPost.post_id, hash: sendPost.snapshot_hash }));
});

test('HTTP accepts a valid decision with rendered SEND binding and refuses stale bindings', async t => {
  const { s, binding, spec, packet } = setup(t), auth = new Auth(s);
  const password = 'leader-long-password-35x'; await auth.createUser('leader', password, true);
  const handler = createHandler({ store: s, auth, secure: false, origin: 'http://localhost' });
  const call = async (method, path, input, headers = {}) => {
    const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path;
    req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, writeHead(code,h={}) { this.status=code; Object.assign(this.headers,h); }, end(v='') { this.text += v; } };
    await handler(req,res); return res;
  };
  const login = await call('POST', '/api/login', { id: 'leader', password });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': JSON.parse(login.text).csrf,
    'x-post-id': binding().post_id, 'x-post-version': binding().post_version };
  const base = { type: 'decided', disposition: 'defer', reason_code: 'not_now', reason: 'Revisit after the service owner confirms readiness.',
    metadata: { owner: 'service-owner', review_by: '2026-12-01' }, spec_hash: spec, packet_hash: packet };
  const stale = await call('POST', '/api/items/item/events', base, { ...headers, 'x-post-version': '0'.repeat(64) });
  assert.equal(stale.status, 409);
  const accepted = await call('POST', '/api/items/item/events', base, headers);
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(s.read('item').context.decided.disposition, 'defer');
});

test('OP withdrawal is current-steward-only and stops an active build', t => {
  const { s, append, binding, spec, packet } = setup(t);
  append({ type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'This bounded trial is independently reviewed.', cap_usd: 2, quorum: 1, max_iterations: 1, window_minutes: 60, ...binding() });
  assert.equal(s.read('item').context.approval, 1);
  const opBinding = binding();
  assert.throws(() => append({ type: 'op_withdrew', actor: 'member', reason: 'The request is no longer needed.', ...opBinding }), /not allowed/);
  const result = append({ type: 'op_withdrew', actor: 'op', reason: 'The request is no longer needed.', ...opBinding });
  assert.ok(result.effects.some(effect => effect.kind === 'build.stop'));
  assert.equal(s.read('item').state, 'SHELVED');
  assert.equal(s.read('item').context.decided.disposition, 'op_withdrew');
  assert.equal(s.read('item').context.approval, 1, 'withdrawal does not mint a new approval');
  assert.ok(s.verifyAll().every(row => row.ok));
});

test('Experiment did not help is a leader closeout, never a HELPS vote', t => {
  const { s, append, binding, spec, packet } = setup(t);
  append({ type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'This bounded trial is independently reviewed.', cap_usd: 2, quorum: 1, ...binding() });
  s.registerToken('runner', { kind: 'run', item: 'item' });
  const approvalBinding = binding();
  append({ type: 'tried', actor: 'runner', approval: 1, spec_hash: spec, iteration: 0, artifact_hash: 'a'.repeat(64), ...approvalBinding });
  const artifactBinding = binding();
  assert.throws(() => append({ type: 'experiment_not_helpful', actor: 'op', approval: 1, spec_hash: spec,
    artifact_hash: 'a'.repeat(64), reason: 'The test did not address the reported handoff failure.', evidence_summary: 'The caller note remained hidden.', ...artifactBinding }), /not allowed/);
  append({ type: 'experiment_not_helpful', actor: 'leader', approval: 1, spec_hash: spec,
    artifact_hash: 'a'.repeat(64), reason: 'The test did not address the reported handoff failure.',
    evidence_summary: 'The caller note remained hidden.', evidence_limits: 'One synthetic test only.', ...artifactBinding });
  const state = s.read('item');
  assert.equal(state.state, 'SPECCED');
  assert.equal(state.context.decided.disposition, 'experiment_did_not_help');
  assert.equal(state.context.helpers.length, 0);
  assert.equal(state.context.activePost, null);
  assert.ok(s.verifyAll().every(row => row.ok));
});

test('rules 2 keeps generic NO classification and replay context unchanged', t => {
  const { s, append, binding, spec, packet } = setup(t, 2);
  const decided = { type: 'decided', actor: 'leader', disposition: 'decline', reason_code: 'benefit_not_worth_cost',
    reason: 'The stated benefit does not justify the cost.', metadata: {}, spec_hash: spec, packet_hash: packet, ...binding() };
  assert.throws(() => append(decided), /not allowed/);
  append({ type: 'not_built', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'Use the existing handoff view before building another one.', ...binding() });
  const context = s.read('item').context;
  assert.equal(context.decided.disposition, 'not_built');
  assert.equal(Object.hasOwn(context.decided, 'bodyHash'), false);
  assert.equal(Object.hasOwn(context.decided, 'reasonCode'), false);
  assert.ok(s.verifyAll().every(row => row.ok));
});
