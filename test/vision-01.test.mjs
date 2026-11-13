import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Readable } from 'node:stream';
import { itemPage } from '../app/pages.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dumpGolden } from '../scripts/dump-golden.mjs';

const at = n => `2026-11-13T00:00:${String(n).padStart(2, '0')}.000Z`;
const append = (store, item, event, n) => store.append(item, { ...event, at: at(n) }, { idem: `v1:${item}:${n}` });

function people(store) {
  store.registerPerson('op');
  store.registerPerson('member');
  store.registerPerson('leader', { leader: true });
}

test('V1 SEE preserves the original, permits only OP revisions, and threads replies on the current SEE', () => {
  const store = new Store();
  people(store);
  store.registerSource('source');
  store.registerToken('run-token', { kind: 'run', item: 'see' });
  const original = 'Calls arrive without the information we need.';
  append(store, 'see', { type: 'posted', actor: 'op', original, rules: 2 }, 1);
  const first = store.events('see')[0];
  const originalHash = first.body_hash;
  assert.deepEqual(store.read('see').context, {
    ...store.read('see').context, rules: 2, steward: 'op', originator: 'op', authors: ['op'],
    seeHash: originalHash, seeVersion: 1,
  });
  assert.throws(() => append(store, 'see', { type: 'checked', actor: 'member', problem: 'take over', looked: ['x'], found: [], verdict: 'build_needed' }, 2), /not allowed/);
  assert.throws(() => append(store, 'see', { type: 'revised', actor: 'member', text: 'no', base_hash: originalHash }, 2), /not allowed/);
  assert.throws(() => append(store, 'see', { type: 'revised', actor: 'leader', text: 'no', base_hash: originalHash }, 2), /not allowed/);
  assert.throws(() => append(store, 'see', { type: 'revised', actor: 'source', text: 'no', base_hash: originalHash }, 2), /not allowed/);
  assert.throws(() => append(store, 'see', { type: 'revised', actor: 'run-token', text: 'no', base_hash: originalHash }, 2), /not allowed/);
  assert.throws(() => append(store, 'see', { type: 'posted', actor: 'op', original: 'second', rules: 2 }, 2), /fresh item/);
  let base = originalHash;
  for (const [n, text] of [[2, 'Calls arrive without the right details.'], [3, 'Calls arrive without the details people need.'], [4, 'Calls arrive without the right details for the people doing the work.']]) {
    append(store, 'see', { type: 'revised', actor: 'op', text, base_hash: base }, n);
    base = store.read('see').context.seeHash;
  }
  assert.equal(store.events('see')[0].original, original);
  assert.equal(store.events('see')[0].body_hash, originalHash);
  assert.equal(store.read('see').context.seeVersion, 4);
  assert.throws(() => append(store, 'see', { type: 'revised', actor: 'op', text: 'stale', base_hash: originalHash }, 5), /not allowed/);
  append(store, 'see', { type: 'commented', actor: 'member', comment: 'Could the intake screen show the missing details?', kind: 'question', anchor_kind: 'see', anchor_hash: base }, 5);
  const parent = store.events('see').at(-1).body_hash;
  append(store, 'see', { type: 'commented', actor: 'op', comment: 'Yes, that is the point.', kind: 'comment', anchor_kind: 'see', anchor_hash: base, parent }, 6);
  append(store, 'other', { type: 'posted', actor: 'member', original: 'Other branch', rules: 2 }, 1);
  const foreign = store.events('other')[0].body_hash;
  assert.throws(() => append(store, 'see', { type: 'commented', actor: 'op', comment: 'wrong parent', kind: 'concern', anchor_kind: 'see', anchor_hash: base, parent: foreign }, 7), /parent/);
  assert.deepEqual(store.verifyAll(), [{ item: 'other', ok: true }, { item: 'see', ok: true }]);
});

test('V1 erasure preserves anchors and comments have their own 1,000-event cap', () => {
  const store = new Store();
  people(store);
  append(store, 'see', { type: 'posted', actor: 'op', original: 'Original', rules: 2 }, 1);
  const seeHash = store.read('see').context.seeHash;
  append(store, 'see', { type: 'commented', actor: 'member', comment: 'A comment', kind: 'comment', anchor_kind: 'see', anchor_hash: seeHash }, 2);
  const target = store.events('see').at(-1).body_hash;
  store.erase('see', target, 'op', at(3));
  append(store, 'see', { type: 'commented', actor: 'op', comment: 'After erase', kind: 'comment', anchor_kind: 'see', anchor_hash: seeHash }, 4);
  assert.deepEqual(store.verifyAll(), [{ item: 'see', ok: true }]);
  append(store, 'see', { type: 'revised', actor: 'op', text: 'A state event still works', base_hash: seeHash }, 5);
  // The cap is a SQL count. Seed the remaining rows directly so this boundary test
  // does not spend seconds replaying an intentionally oversized thread.
  store.db.exec("WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x+1 FROM n WHERE x<1007) INSERT INTO events(item,seq,type,actor) SELECT 'see',x,'commented','member' FROM n");
  assert.throws(() => append(store, 'see', { type: 'commented', actor: 'member', comment: '1001', kind: 'comment', anchor_kind: 'see', anchor_hash: seeHash }, 2000), /item is full/);
});

test('V1 erasure preserves a legacy SPEC anchor too', () => {
  const store = new Store(); people(store);
  append(store, 'legacy', { type: 'checked', actor: 'op', problem: 'Old item', looked: ['checked'], found: [], verdict: 'build_needed' }, 1);
  append(store, 'legacy', { type: 'specced', actor: 'op', must: ['one thing'], how_we_know: ['people tell us'], out_of_scope: [] }, 2);
  const specHash = store.read('legacy').context.specHash;
  append(store, 'legacy', { type: 'commented', actor: 'member', comment: 'spec note', anchor_kind: 'spec', anchor_hash: specHash }, 3);
  store.erase('legacy', store.events('legacy').at(-1).body_hash, 'op', at(4));
  append(store, 'legacy', { type: 'commented', actor: 'member', comment: 'after erase', anchor_kind: 'spec', anchor_hash: specHash }, 5);
  assert.deepEqual(store.verifyAll(), [{ item: 'legacy', ok: true }]);
});

test('V1 post route stamps rules and the page escapes a nested thread', async () => {
  const store = new Store(); const auth = new Auth(store); const password = 'correct-horse-9-battery';
  await auth.createUser('op', password, false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const call = async (path, input, headers = {}) => {
    const req = Readable.from([JSON.stringify(input)]); req.method = 'POST'; req.url = path;
    req.headers = { 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); }, end(v = '') { this.text += v; } };
    await handler(req, res); return { ...res, body: res.text ? JSON.parse(res.text) : {} };
  };
  const login = await call('/api/login', { id: 'op', password });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': login.body.csrf };
  assert.equal((await call('/api/items', { original: 'Words <stay> mine.' }, headers)).status, 201);
  const [item] = store.listItems();
  assert.equal(store.read(item.id).context.rules, 2);
  assert.equal((await call('/api/items', { original: 'forged', rules: 2 }, headers)).status, 409);
  const state = store.read(item.id); const hash = state.context.seeHash;
  store.registerPerson('member');
  append(store, item.id, { type: 'commented', actor: 'member', comment: '<script>alert(1)</script>', kind: 'concern', anchor_kind: 'see', anchor_hash: hash }, 20);
  const page = itemPage({ id: item.id, ...store.read(item.id) }, store.events(item.id), 'op', false);
  assert.match(page, /Original/); assert.match(page, /Current SEE v1/); assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
});

test('F1 rules-2 allows Spec v2 after discussion and a return returns to the spec', () => {
  const store = new Store(); people(store);
  append(store, 'chain', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const seeHash = store.read('chain').context.seeHash;
  append(store, 'chain', { type: 'specced', actor: 'op', see_hash: seeHash, must: ['first'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec1 = store.read('chain').context.specHash;
  const packetHash = store.putArtifact('chain', JSON.stringify({ specHash: spec1 }));
  append(store, 'chain', { type: 'sent', actor: 'op', spec_hash: spec1, packet_hash: packetHash }, 3);
  append(store, 'chain', { type: 'returned', actor: 'leader', note: 'Please explain the affected employee workflow.' }, 4);
  assert.equal(store.read('chain').state, 'SPECCED');
  append(store, 'chain', { type: 'specced', actor: 'op', see_hash: seeHash, must: ['second'], how_we_know: ['test again'], out_of_scope: [] }, 5);
  assert.notEqual(store.read('chain').context.specHash, spec1);
  assert.equal(store.read('chain').context.specVersion, 2);
});

test('F1 shows SEE revision labels from the event sequence, not a missing event field', () => {
  const store = new Store(); people(store);
  append(store, 'labels', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const base = store.read('labels').context.seeHash;
  append(store, 'labels', { type: 'revised', actor: 'op', text: 'Revised SEE', base_hash: base }, 2);
  const page = itemPage({ id: 'labels', ...store.read('labels') }, store.events('labels'), 'op', false);
  assert.match(page, /SEE v2: Revised SEE/);
  assert.doesNotMatch(page, /SEE v: Revised SEE/);
});

test('F1 POST retries use the request idempotency key before rejecting a non-fresh posted item', async () => {
  const store = new Store(); const auth = new Auth(store); const password = 'correct-horse-9-battery';
  await auth.createUser('op', password, false);
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const call = async (path, input, headers = {}) => {
    const req = Readable.from([JSON.stringify(input)]); req.method = 'POST'; req.url = path;
    req.headers = { 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); }, end(v = '') { this.text += v; } };
    await handler(req, res); return { ...res, body: res.text ? JSON.parse(res.text) : {} };
  };
  const login = await call('/api/login', { id: 'op', password });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': login.body.csrf, 'idempotency-key': 'same-post' };
  const first = await call('/api/items', { original: 'Only one post.' }, headers);
  const retry = await call('/api/items', { original: 'Only one post.' }, headers);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(store.events(first.body.id).length, 1);
});

test('F1 migration creates operational tables and an agent Effort identity', () => {
  const store = new Store();
  assert.equal(store.db.prepare("SELECT kind FROM actors WHERE id='effort'").get().kind, 'agent');
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='effort_jobs'").get());
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_effort_receipts'").get());
  assert.ok(store.db.prepare('PRAGMA table_info(runs)').all().some(column => column.name === 'iteration'));
});

test('F1 freezes a sent packet, requires an independent reasoned approval, and restricts agent authority', () => {
  const store = new Store(); people(store);
  append(store, 'send', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const seeHash = store.read('send').context.seeHash;
  append(store, 'send', { type: 'specced', actor: 'op', see_hash: seeHash, must: ['small'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const specHash = store.read('send').context.specHash;
  const packetHash = store.putArtifact('send', JSON.stringify({ specHash }));
  append(store, 'send', { type: 'sent', actor: 'op', spec_hash: specHash, packet_hash: packetHash }, 3);
  assert.throws(() => append(store, 'send', { type: 'approved', actor: 'op', spec_hash: specHash, packet_hash: packetHash, reason: 'A sufficiently detailed reason.', cap_usd: 1, quorum: 1 }, 4), /not allowed/);
  assert.throws(() => append(store, 'send', { type: 'approved', actor: 'leader', spec_hash: specHash, packet_hash: packetHash, reason: 'short', cap_usd: 1, quorum: 1 }, 4), /not allowed/);
  append(store, 'send', { type: 'approved', actor: 'leader', spec_hash: specHash, packet_hash: packetHash, reason: 'This is bounded and independently reviewed.', cap_usd: 1, quorum: 1 }, 4);
  assert.equal(store.read('send').context.iteration, 0);
  assert.throws(() => append(store, 'send', { type: 'commented', actor: 'effort', comment: 'no authority', kind: 'comment', anchor_kind: 'see', anchor_hash: seeHash }, 5), /not allowed/);
  append(store, 'send', { type: 'commented', actor: 'effort', comment: 'I am a thinking partner.', kind: 'agent', job: 'job-1', receipt: 'receipt-1', model: 'fixture', anchor_kind: 'see', anchor_hash: seeHash }, 5);
  store.db.prepare("INSERT INTO actors(id,kind,leader,item) VALUES('rogue-agent','agent',0,NULL)").run();
  assert.throws(() => append(store, 'send', { type: 'commented', actor: 'rogue-agent', comment: 'I am not Effort.', kind: 'agent', job: 'job-2', receipt: 'receipt-2', model: 'fixture', anchor_kind: 'see', anchor_hash: seeHash }, 6), /not allowed/);
  assert.throws(() => append(store, 'send', { type: 'approved', actor: 'effort', spec_hash: specHash, packet_hash: packetHash, reason: 'I should not approve anything.', cap_usd: 1, quorum: 1 }, 6), /not allowed/);
});

test('F1 golden dump retains data rows as INSERT statements', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sss-golden-')), 'golden.sqlite');
  const store = new Store(file); store.registerPerson('op');
  append(store, 'golden', { type: 'posted', actor: 'op', original: 'Keep rows', rules: 2 }, 1);
  store.close();
  const dump = dumpGolden(file);
  assert.match(dump, /INSERT INTO "actors"/);
  assert.match(dump, /Keep rows/);
});

test('F1 rules-2 binds comments, Specs, packets, and approval to the current SEE thread', () => {
  const store = new Store(); people(store);
  append(store, 'bound', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see1 = store.read('bound').context.seeHash;
  append(store, 'bound', { type: 'specced', actor: 'op', see_hash: see1, must: ['first'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec1 = store.read('bound').context.specHash;
  append(store, 'bound', { type: 'revised', actor: 'op', text: 'Current SEE', base_hash: see1 }, 3);
  const see2 = store.read('bound').context.seeHash;
  assert.throws(() => append(store, 'bound', { type: 'commented', actor: 'member', comment: 'stale Spec', kind: 'concern', anchor_kind: 'spec', anchor_hash: spec1 }, 4), /not allowed/);
  assert.throws(() => append(store, 'bound', { type: 'specced', actor: 'op', see_hash: see1, must: ['stale'], how_we_know: ['test'], out_of_scope: [] }, 4), /not allowed/);
  append(store, 'bound', { type: 'specced', actor: 'op', see_hash: see2, must: ['current'], how_we_know: ['test'], out_of_scope: [] }, 4);
  const spec2 = store.read('bound').context.specHash;
  const stalePacket = store.putArtifact('bound', JSON.stringify({ specHash: spec1 }));
  assert.throws(() => append(store, 'bound', { type: 'sent', actor: 'op', spec_hash: spec1, packet_hash: stalePacket }, 5), /not allowed/);
  const packet = store.putArtifact('bound', JSON.stringify({ specHash: spec2 }));
  append(store, 'bound', { type: 'sent', actor: 'op', spec_hash: spec2, packet_hash: packet }, 5);
  assert.throws(() => append(store, 'bound', { type: 'approved', actor: 'leader', spec_hash: spec2, packet_hash: 'wrong', reason: 'This would otherwise be independently reviewed.', cap_usd: 1, quorum: 1 }, 6), /not allowed/);
});

test('F1 rules-2 withdraws a submitted packet on revision and only starts after submission', () => {
  const store = new Store(); people(store);
  append(store, 'withdraw', { type: 'posted', actor: 'op', original: 'Original SEE', rules: 2 }, 1);
  const see1 = store.read('withdraw').context.seeHash;
  append(store, 'withdraw', { type: 'specced', actor: 'op', see_hash: see1, must: ['current'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec = store.read('withdraw').context.specHash;
  const packet = store.putArtifact('withdraw', JSON.stringify({ specHash: spec }));
  assert.throws(() => append(store, 'withdraw', { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'This would otherwise be independently reviewed.', cap_usd: 1, quorum: 1 }, 3), /not allowed/);
  append(store, 'withdraw', { type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet }, 3);
  append(store, 'withdraw', { type: 'revised', actor: 'op', text: 'Changed SEE', base_hash: see1 }, 4);
  assert.equal(store.read('withdraw').state, 'SPECCED');
  assert.equal(store.read('withdraw').context.sent, null);
});

test('F1 rules-2 makes forks, credited revisions, and steering tamper evident', () => {
  const store = new Store(); people(store);
  append(store, 'parent', { type: 'posted', actor: 'op', original: 'Parent SEE', rules: 2 }, 1);
  assert.throws(() => append(store, 'fork', { type: 'forked', actor: 'member', original: 'Fork SEE', rules: 2,
    parent: { item: 'parent', seq: 1, hash: 'not-the-parent-hash' } }, 1), /fork parent/);

  append(store, 'credit', { type: 'posted', actor: 'op', original: 'Credit SEE', rules: 2 }, 1);
  const creditSee = store.read('credit').context.seeHash;
  append(store, 'credit', { type: 'commented', actor: 'member', comment: 'Use the actual call reason.', kind: 'concern', anchor_kind: 'see', anchor_hash: creditSee }, 2);
  const comment = store.events('credit').at(-1).body_hash;
  append(store, 'other-credit', { type: 'posted', actor: 'member', original: 'Other SEE', rules: 2 }, 1);
  append(store, 'other-credit', { type: 'commented', actor: 'leader', comment: 'Other comment.', kind: 'concern', anchor_kind: 'see', anchor_hash: store.read('other-credit').context.seeHash }, 2);
  const foreign = store.events('other-credit').at(-1).body_hash;
  assert.throws(() => append(store, 'credit', { type: 'revised', actor: 'op', text: 'Use the actual call reason.', base_hash: creditSee,
    credits: [{ comment: foreign, mode: 'paraphrased' }] }, 3), /credit/);
  assert.throws(() => append(store, 'credit', { type: 'revised', actor: 'op', text: 'Paraphrase only.', base_hash: creditSee,
    credits: [{ comment, mode: 'quoted' }] }, 3), /quoted credit/);

  append(store, 'steer', { type: 'posted', actor: 'op', original: 'Steer SEE', rules: 2 }, 1);
  const steerSee = store.read('steer').context.seeHash;
  append(store, 'steer', { type: 'specced', actor: 'op', see_hash: steerSee, must: ['current'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const steerSpec = store.read('steer').context.specHash;
  const steerPacket = store.putArtifact('steer', JSON.stringify({ specHash: steerSpec }));
  append(store, 'steer', { type: 'sent', actor: 'op', spec_hash: steerSpec, packet_hash: steerPacket }, 3);
  append(store, 'steer', { type: 'approved', actor: 'leader', spec_hash: steerSpec, packet_hash: steerPacket, reason: 'This is bounded and independently reviewed.', cap_usd: 1, quorum: 1 }, 4);
  assert.throws(() => append(store, 'steer', { type: 'steered', actor: 'member', approval: 1, spec_hash: steerSpec, instruction: 'Make the bounded change.' }, 5), /not allowed/);
  assert.throws(() => append(store, 'steer', { type: 'steered', actor: 'op', approval: 2, spec_hash: steerSpec, instruction: 'Make the bounded change.' }, 5), /not allowed/);
});

test('F1 rules-2 limits steering and rejects stale run reports', () => {
  const store = new Store(); people(store);
  store.registerToken('run', { kind: 'run', item: 'iterate' });
  append(store, 'iterate', { type: 'posted', actor: 'op', original: 'Iteration SEE', rules: 2 }, 1);
  const see = store.read('iterate').context.seeHash;
  append(store, 'iterate', { type: 'specced', actor: 'op', see_hash: see, must: ['current'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec = store.read('iterate').context.specHash;
  const packet = store.putArtifact('iterate', JSON.stringify({ specHash: spec }));
  append(store, 'iterate', { type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet }, 3);
  append(store, 'iterate', { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'This is bounded and independently reviewed.', cap_usd: 1, quorum: 1 }, 4);
  for (let n = 0; n < 5; n += 1) append(store, 'iterate', { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: `Bounded correction ${n}.` }, n + 5);
  assert.throws(() => append(store, 'iterate', { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: 'Sixth correction is not allowed.' }, 10), /not allowed/);
  assert.throws(() => append(store, 'iterate', { type: 'tried', actor: 'run', approval: 1, spec_hash: spec, iteration: 4, artifact_hash: 'artifact' }, 10), /iteration/);
});

test('F1 rules-2 refuses approval by a leader who authored the packet', () => {
  const store = new Store(); people(store);
  append(store, 'author', { type: 'posted', actor: 'leader', original: 'Leader authored SEE', rules: 2 }, 1);
  const see = store.read('author').context.seeHash;
  append(store, 'author', { type: 'specced', actor: 'leader', see_hash: see, must: ['current'], how_we_know: ['test'], out_of_scope: [] }, 2);
  const spec = store.read('author').context.specHash;
  const packet = store.putArtifact('author', JSON.stringify({ specHash: spec }));
  append(store, 'author', { type: 'sent', actor: 'leader', spec_hash: spec, packet_hash: packet }, 3);
  assert.throws(() => append(store, 'author', { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'An author cannot independently approve their own work.', cap_usd: 1, quorum: 1 }, 4), /not allowed/);
});
