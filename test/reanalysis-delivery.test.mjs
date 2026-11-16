import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readdirSync, readFileSync } from 'node:fs';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { runReanalysis } from '../reanalysis/run.js';
import { recordAnnex } from '../reanalysis/annex.js';
import { deliverAnnexes } from '../notifications/digest.js';

const stamp = '2026-11-10T12:00:00.000Z', later = '2026-11-16T12:00:00.000Z';
const password = 'correct-horse-9-battery';
let n = 0;

async function world(t) {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store);
  for (const [id, leader] of [['dana', false], ['sam', false], ['lee', true], ['pat', false]]) await auth.createUser(id, password, leader);
  const add = (item, event) => store.append(item, { ...event, at: stamp }, { idem: `dv-${++n}` });
  const bind = item => ({ post_id: store.read(item).context.activePost?.id, post_version: store.read(item).context.activePost?.version });
  function item(name, author, original, assumption) {
    add(name, { type: 'posted', actor: author, original, rules: 3 });
    add(name, { type: 'specced', actor: author, see_hash: store.read(name).context.seeHash, must: ['Keep the caller note'], how_we_know: ['The note appears'], out_of_scope: [], assumptions: [assumption], open_questions: [], ...bind(name) });
    const spec = store.read(name).context.specHash, packet = store.putArtifact(name, JSON.stringify({ specHash: spec }));
    add(name, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(name) });
    return { spec, packet };
  }
  const d = item('dana', 'dana', 'The handoff loses the caller note.', 'The handoff needs a new integration to carry the caller note.');
  add('dana', { type: 'decided', actor: 'lee', disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration this quarter.', metadata: {}, spec_hash: d.spec, packet_hash: d.packet, ...bind('dana') });
  const s = item('sam', 'sam', 'Night shift cannot see the export.', 'The export permission is the only blocker.');
  add('sam', { type: 'decided', actor: 'lee', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'The existing export already carries the caller note across the handoff, so no integration is needed.', metadata: { alternative: 'Use the export.', action_owner: 'sam' }, spec_hash: s.spec, packet_hash: s.packet, ...bind('sam') });
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost', clock: () => Date.parse(later) });
  const sessions = {};
  for (const id of ['dana', 'sam', 'lee', 'pat']) { const r = await auth.login(id, password, '127.0.0.1'); sessions[id] = { cookie: `sss=${r.value}`, csrf: r.csrf }; }
  const call = async (method, path, who, input, extra = {}) => {
    const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
    req.method = method; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { ...(who ? { cookie: sessions[who].cookie, origin: 'http://localhost', 'x-csrf-token': sessions[who].csrf } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...extra };
    const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(c, h = {}) { this.status = c; Object.assign(this.headers, h); }, end(v = '') { this.text += v; } };
    await handler(req, res); return { status: res.status, text: res.text, json: () => JSON.parse(res.text) };
  };
  return { store, call, add, bind };
}
const fingerprint = (s, item) => ({ events: s.eventRows(item).map(row => row.hash), posts: JSON.stringify(s.db.prepare('SELECT * FROM stage_posts WHERE item=? ORDER BY post_id').all(item)), ok: s.verify(item).ok });

test('recipients are the steward, author and decider, each gets one entry and at most one ping a day', async t => {
  const { store } = await world(t);
  runReanalysis(store, { now: later });
  const rows = store.db.prepare('SELECT person, pinged FROM digest_entries ORDER BY person').all();
  assert.deepEqual(rows.map(r => r.person), ['dana', 'lee'], 'dana is steward and author; lee decided; pat and sam are not recipients');
  assert.ok(rows.every(r => r.pinged === 1));
  // A second annex the same day creates entries but no second ping.
  const first = store.knowledge.entries('annex')[0].body;
  recordAnnex(store, { ...first, what_is_new: ['A different recorded result.'] }, { at: later });
  const again = deliverAnnexes(store, { now: later });
  assert.equal(again.entries, 2); assert.equal(again.pinged, 0);
  // The next day pings resume; a muted person never pings.
  store.db.prepare('INSERT INTO reanalysis_mute(person) VALUES(?)').run('lee');
  recordAnnex(store, { ...first, what_is_new: ['Yet another recorded result.'] }, { at: later });
  const nextDay = deliverAnnexes(store, { now: '2026-11-17T12:00:00.000Z' });
  assert.equal(store.db.prepare("SELECT pinged FROM digest_entries WHERE person='lee' ORDER BY created_at DESC LIMIT 1").get().pinged, 0);
  assert.equal(nextDay.pinged, 1, 'only the unmuted person is pinged');
});

test('updates, digest and responses are read-gated, attributed, and never hide or delete an annex', async t => {
  const { store, call } = await world(t);
  runReanalysis(store, { now: later });
  const hash = store.knowledge.entries('annex')[0].hash;
  assert.equal((await call('GET', '/api/items/dana/updates', null)).status, 403, 'sign-in required');
  const updates = await call('GET', '/api/items/dana/updates', 'sam');
  assert.equal(updates.status, 200); assert.equal(updates.json().annexes.length, 1);
  assert.match(updates.json().annexes[0].body.statement, /Found by Effort \(AI\)/);
  assert.equal((await call('POST', `/api/annexes/${hash}/response`, 'pat', { kind: 'bogus' })).status, 409);
  assert.equal((await call('POST', `/api/annexes/${hash}/response`, 'pat', { kind: 'relevant' })).status, 201);
  assert.equal((await call('POST', `/api/annexes/${hash}/response`, 'dana', { kind: 'not_relevant' })).status, 201);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM digest_entries WHERE person='dana'").get().n, 0, 'only her own digest entry is removed');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM digest_entries WHERE person='lee'").get().n, 1, 'others keep theirs');
  const after = (await call('GET', '/api/items/dana/updates', 'sam')).json().annexes;
  assert.equal(after.length, 1, 'the annex is still visible to everyone');
  assert.equal(after[0].responses.length, 2); assert.deepEqual(after[0].responses.map(r => r.body.actor).sort(), ['dana', 'pat']);
  assert.equal((await call('POST', `/api/annexes/${hash}/response`, 'sam', { kind: 'mute' })).status, 201);
  assert.ok(store.db.prepare("SELECT 1 FROM reanalysis_mute WHERE person='sam'").get());
  assert.equal(store.knowledge.verify().ok, true);
  const digest = (await call('GET', '/api/digest', 'lee')).json();
  assert.equal(digest.entries.length, 1);
});

test('the frozen page shows updates outside the frozen thread, labeled AI, escaped, with response controls', async t => {
  const { store, call } = await world(t);
  runReanalysis(store, { now: later });
  const annex = store.knowledge.entries('annex')[0];
  recordAnnex(store, { ...annex.body, what_is_new: ['<script>alert(1)</script> hostile text'] }, { at: later });
  const page = await call('GET', '/items/dana', 'pat');
  assert.equal(page.status, 200);
  assert.match(page.text, /Updates since this was frozen/);
  assert.match(page.text, /Found by Effort \(AI\)/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /Not relevant/);
  const frozenAt = page.text.indexOf('Updates since this was frozen');
  assert.ok(frozenAt > -1);
});

test('a new decision is a renewal on new information; the old case is untouched', async t => {
  const { store, call } = await world(t);
  runReanalysis(store, { now: later });
  const annex = store.knowledge.entries('annex')[0].hash;
  const before = fingerprint(store, 'dana');
  const body = { annex, what_is_new: 'A later case solved this with the existing export, no integration.', reason: 'Asking for a new decision on the new information.' };
  const refusedOutsider = await call('POST', '/api/items/dana/renew', 'sam', body);
  assert.notEqual(refusedOutsider.status, 201, 'only the steward or original author may renew');
  assert.equal((await call('POST', '/api/items/dana/renew', 'dana', { ...body, what_is_new: '' })).status, 409, 'what is new is required');
  assert.equal((await call('POST', '/api/items/dana/renew', 'dana', { ...body, annex: 'a'.repeat(64) })).status >= 400, true, 'the annex must exist');
  const made = await call('POST', '/api/items/dana/renew', 'dana', body);
  assert.equal(made.status, 201);
  const child = made.json().id;
  const first = store.events(child)[0];
  assert.equal(first.relation, 'renewal'); assert.equal(first.basis.annex, annex);
  assert.equal(store.read(child).context.approval, 0, 'a renewal inherits no approval');
  assert.equal(store.db.prepare('SELECT relation FROM lineage_relations WHERE child=?').get(child).relation, 'renewal');
  const again = await call('POST', '/api/items/dana/renew', 'dana', { ...body, what_is_new: 'Same annex again.' });
  assert.notEqual(again.status, 201, 'one renewal per annex per person');
  assert.deepEqual(fingerprint(store, 'dana'), before, 'the old declined case is byte-identical');
  store.rebuild();
  assert.equal(store.db.prepare('SELECT relation FROM lineage_relations WHERE child=?').get(child).relation, 'renewal', 'relation survives rebuild');
});

test('the leader sees the prior decision and the new information side by side in the renewal packet', async t => {
  const { store, call, add, bind } = await world(t);
  runReanalysis(store, { now: later });
  const annex = store.knowledge.entries('annex')[0].hash;
  const made = await call('POST', '/api/items/dana/renew', 'dana', { annex, what_is_new: 'A later case solved this with the existing export.', reason: 'New information.' });
  const child = made.json().id;
  store.append(child, { type: 'specced', actor: 'dana', see_hash: store.read(child).context.seeHash, must: ['Keep the caller note'], how_we_know: ['The note appears'], out_of_scope: [], ...bind(child), at: stamp }, { idem: 'rn-1' });
  const spec = store.read(child).context.specHash;
  const active = store.read(child).context.activePost;
  const sent = await call('POST', `/api/items/${child}/send`, 'dana', { spec_hash: spec }, { 'x-post-id': active.id, 'x-post-version': active.version });
  assert.equal(sent.status, 201, sent.text);
  const packet = JSON.parse(store.artifact(child, sent.json().packet_hash));
  assert.equal(packet.v, 3);
  assert.equal(packet.prior_decision.reason, 'No budget for a new integration this quarter.', 'quoted verbatim');
  assert.equal(packet.prior_decision.who, 'lee');
  assert.match(packet.new_information.what_is_new, /existing export/);
  assert.equal(packet.new_information.annex, annex);
});

test('static: delivery code never reads the leader flag or counts renewals or responses per person', () => {
  const files = ['notifications', 'reanalysis', 'knowledge'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`));
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /\.leader\b|actors\.leader|is_leader/, file);
    assert.doesNotMatch(code, /GROUP\s+BY\s+(actor|person)|count\s*\(.*(actor|person)/i, file);
    assert.doesNotMatch(code, /mentor_/, file);
  }
  const http = readFileSync('app/http.js', 'utf8');
  assert.doesNotMatch(http, /renewals?_per|reversal_count|yes_rate/i);
});

test('a correction can target a source event, as the closing-report button does, and never changes the source', async t => {
  const { store, call } = await world(t);
  const decision = store.eventRows('dana').find(row => row.type === 'decided');
  const before = store.eventRows('dana').map(row => row.hash);
  assert.equal((await call('POST', `/api/knowledge/${decision.body_hash}/correction`, 'pat', { note: 'Context: an existing export covers this.' })).status, 201);
  assert.equal((await call('POST', `/api/knowledge/${'a'.repeat(64)}/correction`, 'pat', { note: 'Nothing here.' })).status, 403, 'an unknown target is refused');
  assert.equal((await call('POST', `/api/knowledge/${decision.body_hash}/correction`, 'pat', { note: '' })).status >= 400, true, 'an empty note is refused');
  const entry = store.knowledge.entries('correction')[0].body;
  assert.equal(entry.actor, 'pat'); assert.equal(entry.target, decision.body_hash);
  assert.deepEqual(store.eventRows('dana').map(row => row.hash), before);
});
