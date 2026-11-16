import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { rmSync } from 'node:fs';
import { Store } from '../core/store.js';
import { buildCloseout, runCloseoutJobs } from '../core/closeout.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

const stamp = '2026-11-16T12:00:00.000Z';

function fixture(t, file = ':memory:') {
  const store = new Store(file); t.after(() => { try { store.close(); } catch {} });
  store.registerPerson('op'); store.registerPerson('peer');
  let number = 0;
  const append = event => store.append('item', { ...event, at: stamp }, { idem: `closeout-${++number}` });
  append({ type: 'posted', actor: 'op', original: 'Caller notes disappear.', rules: 3 });
  const binding = () => ({ post_id: store.read('item').context.activePost.id, post_version: store.read('item').context.activePost.version });
  return { store, append, binding };
}

test('closeout report separates recorded types and preserves source references', () => {
  const events = [
    { seq: 1, body_hash: 'a', type: 'posted', actor: 'op', evidence: [{ kind: 'documented', url: 'https://example.test/a', claim: 'A record exists' }] },
    { seq: 2, body_hash: 'b', type: 'commented', actor: 'peer', kind: 'question', comment: 'Which system owns it?' },
    { seq: 3, body_hash: 'c', type: 'commented', actor: 'peer', kind: 'concern', comment: 'The handoff can still fail.' },
    { seq: 4, body_hash: 'd', type: 'commented', actor: 'peer', kind: 'alternative', comment: 'Use the existing screen.' },
    { seq: 5, body_hash: 'e', type: 'specced', actor: 'op', assumptions: ['The old screen remains available.'], open_questions: ['Who verifies the migration?'], credits: [{ comment: 'd', mode: 'paraphrased' }], evidence: [{ kind: 'reported', url: 'https://example.test/b', claim: 'A caller reported a failure.', reported_by: 'op' }] },
    { seq: 6, body_hash: 'f', type: 'decided', actor: 'leader', disposition: 'defer', reason: 'A dependency needs review.', reason_code: 'dependency', metadata: { owner: 'op' } },
  ];
  const post = { item: 'item', post_id: 'send:a', kind: 'send', opened_seq: 1, closed_seq: 6, snapshot_hash: 'snapshot', successor_post_id: 'spec:g' };
  const report = buildCloseout(events, post, { hash: 'snapshot', body_hash: 'f' });
  assert.equal(report.facts[0].body_hash, 'a');
  assert.equal(report.reported_claims[0].body_hash, 'e');
  assert.equal(report.assumptions[0].body_hash, 'e');
  assert.equal(report.open_questions[0].body_hash, 'e');
  assert.deepEqual(report.discussion.map(row => row.type), ['question', 'concern', 'alternative']);
  assert.equal(report.discussion[2].reconciliation_status, 'incorporated');
  assert.equal(report.credits[0].original_attribution.actor, 'peer');
  assert.equal(report.decisions[0].outcome, 'defer');
  assert.equal(report.next_stage.post_id, 'spec:g');
  assert.doesNotMatch(JSON.stringify(report), /rank|score|motive|employee_count/i);
});

test('consumer is idempotent, restart-safe, and regenerates erased source views', t => {
  const file = '/tmp/sss-closeout-test.sqlite'; rmSync(file, { force: true }); t.after(() => rmSync(file, { force: true }));
  let { store, append, binding } = fixture(t, file);
  const see = store.read('item').context.seeHash;
  append({ type: 'commented', actor: 'peer', kind: 'alternative', anchor_kind: 'see', anchor_hash: see, comment: 'Use the current CRM panel.', ...binding() });
  const comment = store.events('item').at(-1).body_hash;
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep caller notes'], how_we_know: ['The note appears'], out_of_scope: [], assumptions: ['The CRM stays online'], open_questions: ['Who owns access?'], ...binding() });
  assert.deepEqual(runCloseoutJobs(store, {}), { processed: 1 });
  assert.deepEqual(runCloseoutJobs(store, {}), { processed: 0 });
  const before = store.db.prepare('SELECT * FROM closeout_jobs').get();
  assert.equal(before.state, 'done'); assert.match(before.artifact_hash, /^[a-f0-9]{64}$/);
  assert.ok(store.verifyAll().every(row => row.ok));
  store.close();
  store = new Store(file);
  t.after(() => { try { store.close(); } catch {} });
  assert.deepEqual(runCloseoutJobs(store, {}), { processed: 0 });
  assert.equal(store.db.prepare('SELECT artifact_hash FROM closeout_jobs').get().artifact_hash, before.artifact_hash);
  store.erase('item', comment, 'peer', stamp);
  assert.equal(store.db.prepare('SELECT state FROM closeout_jobs').get().state, 'pending');
  assert.deepEqual(runCloseoutJobs(store, {}), { processed: 1 });
  const report = JSON.parse(store.artifact('item', store.db.prepare('SELECT artifact_hash FROM closeout_jobs').get().artifact_hash));
  assert.equal(report.discussion[0].text, '[erased]'); assert.equal(report.discussion[0].erased, true);
  store.rebuild(); assert.ok(store.verifyAll().every(row => row.ok));
});

test('closeout API is read-only, authenticated, and available from the frozen post', async t => {
  const { store, append, binding } = fixture(t);
  const see = store.read('item').context.seeHash;
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep caller notes'], how_we_know: ['The note appears'], out_of_scope: [], ...binding() });
  runCloseoutJobs(store, {});
  const post = store.db.prepare("SELECT * FROM stage_posts WHERE item='item' AND kind='see'").get();
  const auth = new Auth(store); await auth.createUser('viewer', 'viewer-password-123', false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const call = async (path, cookie) => {
    const req = Readable.from([]); req.method = 'GET'; req.url = path; req.headers = cookie ? { cookie } : {}; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(code, h = {}) { this.status = code; Object.assign(this.headers, h); }, end(value = '') { this.text += value; } };
    await handler(req, res); return res;
  };
  assert.equal((await call(`/api/items/item/closeout/${encodeURIComponent(post.post_id)}`)).status, 403);
  const login = await auth.login('viewer', 'viewer-password-123', '127.0.0.1');
  const route = await call(`/api/items/item/closeout/${encodeURIComponent(post.post_id)}`, `sss=${login.value}`);
  assert.equal(route.status, 200); assert.equal(JSON.parse(route.text).post.id, post.post_id);
  const history = await call(`/items/item/history/${encodeURIComponent(post.post_id)}`, `sss=${login.value}`);
  assert.match(history.text, /Read closing report/);
});
