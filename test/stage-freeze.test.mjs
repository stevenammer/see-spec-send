import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { EffortWorker } from '../app/effort.js';
import { EffortGateway } from '../gateway/effort.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { fixtureProvider } from '../gateway/fixture.js';

const stamp = '2026-11-15T12:00:00.000Z';
function setup(t) {
  const s = new Store(); t.after(() => s.close());
  s.registerPerson('op'); s.registerPerson('peer'); s.registerPerson('leader', { leader: true });
  let n = 0;
  const append = (body, idem = `event-${++n}`) => s.append('item', { ...body, at: stamp }, { idem });
  append({ type: 'posted', actor: 'op', original: 'A handoff problem.', rules: 3 });
  const binding = () => ({ post_id: s.read('item').context.activePost?.id, post_version: s.read('item').context.activePost?.version });
  return { s, append, binding };
}

test('SEE freeze is atomic and rejects stale writes; return opens a distinct linked SPEC', t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash, old = binding();
  append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'see', anchor_hash: see, comment: 'A useful detail.', ...old });
  append({ type: 'commented', actor: 'op', kind: 'comment', anchor_kind: 'see', anchor_hash: see, comment: 'Another concurrent detail.', ...old });
  const snapshotHead = s.eventRows('item').at(-1).hash;
  const spec = { type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['The next person sees it'], out_of_scope: [], ...old };
  append(spec, 'spec-once');
  assert.equal(append(spec, 'spec-once').idempotent, true);
  assert.throws(() => append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'see', anchor_hash: see, comment: 'Too late.', ...old }), /frozen or superseded/);
  assert.throws(() => append({ type: 'revised', actor: 'op', text: 'Too late.', base_hash: see, ...old }), /frozen or superseded/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM closeout_jobs').get().n, 1);
  assert.equal(s.db.prepare('SELECT snapshot_hash FROM stage_posts WHERE post_id=?').get(old.post_id).snapshot_hash, snapshotHead);
  const firstSpec = binding(); const specHash = s.read('item').context.specHash;
  const packet = s.putArtifact('item', JSON.stringify({ specHash }));
  append({ type: 'sent', actor: 'op', spec_hash: specHash, packet_hash: packet, ...firstSpec });
  const send = binding();
  append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'send', anchor_hash: send.post_version, comment: 'A review question.', ...send });
  assert.throws(() => append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'spec', anchor_hash: specHash, comment: 'Too late.', ...firstSpec }), /frozen or superseded/);
  append({ type: 'returned', actor: 'leader', reason: 'Please provide the missing detail.', spec_hash: specHash, packet_hash: packet, ...binding() });
  assert.notEqual(binding().post_id, firstSpec.post_id);
  const sendPost = s.db.prepare('SELECT * FROM stage_posts WHERE post_id=?').get(send.post_id);
  const decision = s.db.prepare('SELECT * FROM stage_posts WHERE post_id=?').get(sendPost.successor_post_id);
  assert.equal(decision.kind, 'decision'); assert.equal(decision.successor_post_id, binding().post_id);
  assert.equal(s.db.prepare('SELECT previous_post_id FROM stage_posts WHERE post_id=?').get(binding().post_id).previous_post_id, decision.post_id);
  assert.throws(() => append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'send', anchor_hash: send.post_version, comment: 'Late review.', ...send }), /frozen or superseded/);
  assert.equal(binding().post_version, specHash);
  assert.throws(() => append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'spec', anchor_hash: specHash, comment: 'Old tab.', ...firstSpec }), /frozen or superseded/);
  append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'spec', anchor_hash: specHash, comment: 'New discussion.', ...binding() });
  assert.equal(s.db.prepare('SELECT count(*) n FROM closeout_jobs').get().n, 4);
  assert.ok(s.verifyAll().every(row => row.ok));
  s.rebuild(); assert.ok(s.verifyAll().every(row => row.ok));
});

test('delayed AI reply does not retarget the new post or trigger another call', async t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash;
  const ledger = new Ledger(s); ledger.configure(fixturePolicy());
  let calls = 0;
  const gateway = new EffortGateway(ledger, async input => {
    calls++;
    append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['Find it'], out_of_scope: [], ...binding() });
    return fixtureProvider(input);
  });
  const worker = new EffortWorker(s, gateway);
  assert.equal(await worker.tick(), false);
  assert.equal(calls, 1);
  assert.equal(s.events('item').filter(e => e.actor === 'effort').length, 0);
  const first = s.db.prepare("SELECT state,last_error FROM effort_jobs WHERE kind='see_first'").get();
  assert.equal(first.state, 'blocked'); assert.match(first.last_error, /frozen|superseded/);
  assert.equal(ledger.effortReceipts().length, 1);
});

test('failure creating the closeout rolls back the transition and preserves the active post', t => {
  const { s, append, binding } = setup(t), old = binding(), head = s.eventRows('item').at(-1).hash;
  s.db.exec("CREATE TRIGGER fail_closeout BEFORE INSERT ON closeout_jobs BEGIN SELECT RAISE(ABORT, 'injected closeout failure'); END");
  assert.throws(() => append({ type: 'specced', actor: 'op', see_hash: s.read('item').context.seeHash, must: ['One'], how_we_know: ['Test'], out_of_scope: [], ...old }), /injected closeout failure/);
  assert.equal(s.eventRows('item').at(-1).hash, head);
  assert.deepEqual(binding(), old);
  assert.equal(s.db.prepare('SELECT count(*) n FROM stage_posts WHERE closed_seq IS NOT NULL').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM closeout_jobs').get().n, 0);
});

test('frozen exact snapshot can be forked independently and privacy erasure preserves replay', t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash;
  append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'see', anchor_hash: see, comment: 'A private detail.', ...binding() });
  const comment = s.events('item').at(-1).body_hash;
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep context'], how_we_know: ['Find it'], out_of_scope: [], ...binding() });
  const snapshot = s.db.prepare("SELECT * FROM stage_posts WHERE kind='see'").get();
  const from = { kind: 'snapshot', post_id: snapshot.post_id, hash: snapshot.snapshot_hash };
  const point = s.forkPoint('item', from, undefined, { extended: true });
  s.append('fork', { type: 'forked', actor: 'peer', ...point, seed_policy: 2, from, rules: 3, reason: 'Explore a different route.', at: stamp }, { idem: 'fork-one' });
  assert.equal(s.read('fork').context.approval, 0);
  assert.equal(s.events('fork')[0].parent.hash, snapshot.snapshot_hash);
  s.erase('item', comment, 'peer', stamp);
  assert.ok(s.verifyAll().every(row => row.ok));
  assert.match(s.events('item').find(e => e.body_hash === comment).comment, /erased/);
});

test('HTTP requires the rendered rules-3 binding and refuses an old SEE tab', async t => {
  const { Readable } = await import('node:stream');
  const { Auth } = await import('../app/auth.js');
  const { createHandler } = await import('../app/http.js');
  const s = new Store(); t.after(() => s.close()); const auth = new Auth(s);
  await auth.createUser('olive', 'olive-long-password-9x', false);
  const handler = createHandler({ store: s, auth, secure: false, origin: 'http://localhost' });
  const call = async (method, path, input, headers = {}) => {
    const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]); req.method = method; req.url = path;
    req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, writeHead(code,h={}) { this.status=code; Object.assign(this.headers,h); }, end(v='') { this.text+=v; } };
    await handler(req,res); return res;
  };
  const login = await call('POST','/api/login',{ id:'olive', password:'olive-long-password-9x' });
  const csrf = JSON.parse(login.text).csrf;
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin:'http://localhost', 'x-csrf-token':csrf };
  const created = await call('POST','/api/items',{ original:'A handoff fails.' },headers);
  const id = JSON.parse(created.text).id, context = s.read(id).context;
  assert.equal(context.rules,3);
  const oldHeaders = { ...headers, 'x-post-id':context.activePost.id, 'x-post-version':context.activePost.version };
  const spec = { type:'specced', see_hash:context.seeHash, must:['Keep notes'], how_we_know:['Find them'], out_of_scope:[] };
  assert.equal((await call('POST',`/api/items/${id}/events`,spec,headers)).status,409);
  assert.equal((await call('POST',`/api/items/${id}/events`,spec,oldHeaders)).status,201);
  const oldComment = { type:'commented', kind:'comment', anchor_kind:'see', anchor_hash:context.seeHash, comment:'Late tab.' };
  const stale = await call('POST',`/api/items/${id}/events`,oldComment,oldHeaders);
  assert.equal(stale.status,409); assert.equal(JSON.parse(stale.text).error,'frozen or superseded post');
  const current = s.read(id).context.activePost;
  const newHeaders = { ...headers, 'x-post-id':current.id, 'x-post-version':current.version };
  assert.equal((await call('POST',`/api/items/${id}/events`,{ type:'commented', kind:'comment', anchor_kind:'spec', anchor_hash:current.version, comment:'Current thread.' },newHeaders)).status,201);
  const post = s.db.prepare("SELECT * FROM stage_posts WHERE item=? AND kind='see'").get(id);
  const page = await call('GET',`/items/${id}/history/${encodeURIComponent(post.post_id)}`,undefined,headers);
  assert.equal(page.status,200); assert.match(page.text,/Frozen see post/); assert.doesNotMatch(page.text,/Post comment/); assert.match(page.text,/Fork frozen stage/);
});

test('export and import rebuild exact stage history without losing independent fork authority', t => {
  const { s, append, binding } = setup(t);
  append({ type: 'specced', actor: 'op', see_hash: s.read('item').context.seeHash, must: ['Keep it'], how_we_know: ['Find it'], out_of_scope: [], ...binding() });
  const closed = s.db.prepare("SELECT * FROM stage_posts WHERE kind='see'").get();
  const from = { kind: 'snapshot', post_id: closed.post_id, hash: closed.snapshot_hash }, point = s.forkPoint('item', from, undefined, { extended: true });
  s.append('fork', { type: 'forked', actor: 'peer', ...point, from, rules: 3, seed_policy: 2, reason: 'Try another approach.', at: stamp }, { idem:'fork' });
  const restored = new Store(); t.after(() => restored.close()); restored.importJsonl(s.exportJsonl());
  assert.deepEqual(restored.db.prepare('SELECT * FROM stage_posts ORDER BY item,post_id').all(), s.db.prepare('SELECT * FROM stage_posts ORDER BY item,post_id').all());
  assert.ok(restored.verifyAll().every(row => row.ok));
  assert.equal(restored.read('fork').context.approval, 0);
});

test('approval freezes SEND and a new TRY freezes the previous vote and feedback context', t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash;
  append({ type:'specced', actor:'op', see_hash:see, must:['Keep it'], how_we_know:['Find it'], out_of_scope:[], ...binding() });
  const specHash=s.read('item').context.specHash, packet=s.putArtifact('item',JSON.stringify({specHash}));
  append({ type:'sent',actor:'op',spec_hash:specHash,packet_hash:packet,...binding() });
  const send=binding();
  append({ type:'approved',actor:'leader',spec_hash:specHash,packet_hash:packet,reason:'A limited test is justified.',cap_usd:1,quorum:1,...send });
  assert.throws(() => append({ type:'commented',actor:'peer',kind:'comment',anchor_kind:'send',anchor_hash:send.post_version,comment:'Late.',...send }),/frozen or superseded/);
  s.registerToken('runner',{kind:'run',item:'item'});
  const artifact=s.putArtifact('item','<p>first</p>');
  append({type:'tried',actor:'runner',approval:1,spec_hash:specHash,artifact_hash:artifact,iteration:0});
  const old=binding();
  append({type:'commented',actor:'peer',kind:'comment',anchor_kind:'artifact',anchor_hash:artifact,comment:'Improve this.',...old});
  append({type:'steered',actor:'op',approval:1,spec_hash:specHash,instruction:'Improve this.',...old});
  assert.throws(() => append({type:'helped',actor:'peer',artifact_hash:artifact,...old}),/frozen or superseded/);
  assert.throws(() => append({type:'commented',actor:'peer',kind:'comment',anchor_kind:'artifact',anchor_hash:artifact,comment:'Late.',...old}),/frozen or superseded/);
  assert.ok(s.verifyAll().every(row=>row.ok));
});

test('final HELPS vote is included in the frozen TRY snapshot', t => {
  const { s, append, binding } = setup(t), see=s.read('item').context.seeHash;
  append({type:'specced',actor:'op',see_hash:see,must:['Keep it'],how_we_know:['Find it'],out_of_scope:[],...binding()});
  const specHash=s.read('item').context.specHash, packet=s.putArtifact('item',JSON.stringify({specHash}));
  append({type:'sent',actor:'op',spec_hash:specHash,packet_hash:packet,...binding()});
  append({type:'approved',actor:'leader',spec_hash:specHash,packet_hash:packet,reason:'A small test is justified.',cap_usd:1,quorum:1,...binding()});
  s.registerToken('runner',{kind:'run',item:'item'}); const artifact=s.putArtifact('item','<p>try</p>');
  append({type:'tried',actor:'runner',approval:1,spec_hash:specHash,artifact_hash:artifact,iteration:0});
  const post=binding().post_id;
  append({type:'helped',actor:'peer',artifact_hash:artifact,...binding()});
  const final=s.eventRows('item').at(-1), snapshot=s.db.prepare('SELECT * FROM stage_posts WHERE post_id=?').get(post);
  assert.equal(snapshot.closed_seq,final.seq); assert.equal(snapshot.snapshot_hash,final.hash);
  assert.equal(s.read('item').state,'HELPS'); assert.ok(s.verifyAll().every(row=>row.ok));
});

test('Effort can answer a mention on the current TRY without moving it to another stage', async t => {
  const { s, append, binding } = setup(t), see=s.read('item').context.seeHash;
  append({type:'specced',actor:'op',see_hash:see,must:['Keep it'],how_we_know:['Find it'],out_of_scope:[],...binding()});
  const specHash=s.read('item').context.specHash, packet=s.putArtifact('item',JSON.stringify({specHash}));
  append({type:'sent',actor:'op',spec_hash:specHash,packet_hash:packet,...binding()});
  append({type:'approved',actor:'leader',spec_hash:specHash,packet_hash:packet,reason:'A small test is justified.',cap_usd:1,quorum:1,...binding()});
  s.registerToken('runner',{kind:'run',item:'item'}); const artifact=s.putArtifact('item','<p>try</p>');
  append({type:'tried',actor:'runner',approval:1,spec_hash:specHash,artifact_hash:artifact,iteration:0});
  s.db.prepare("UPDATE effort_jobs SET state='blocked' WHERE kind != 'tag'").run();
  append({type:'commented',actor:'peer',kind:'comment',anchor_kind:'artifact',anchor_hash:artifact,comment:'@effort What should we test?',...binding()});
  const trigger=s.events('item').at(-1).body_hash, ledger=new Ledger(s); ledger.configure(fixturePolicy());
  assert.equal(await new EffortWorker(s,new EffortGateway(ledger,fixtureProvider)).tick(),true);
  const reply=s.events('item').at(-1); assert.equal(reply.parent,trigger); assert.equal(reply.anchor_hash,artifact); assert.equal(reply.post_id,binding().post_id);
});

test('same-head decision and returned SPEC snapshots retain distinct fork source identities', t => {
  const { s, append, binding }=setup(t), see=s.read('item').context.seeHash;
  append({type:'specced',actor:'op',see_hash:see,must:['Keep'],how_we_know:['Find'],out_of_scope:[],...binding()});
  const specHash=s.read('item').context.specHash, first=s.putArtifact('item',JSON.stringify({specHash, version:1}));
  append({type:'sent',actor:'op',spec_hash:specHash,packet_hash:first,...binding()});
  append({type:'returned',actor:'leader',spec_hash:specHash,packet_hash:first,reason:'Please reconsider the evidence.',...binding()});
  const second=s.putArtifact('item',JSON.stringify({specHash, version:2}));
  append({type:'sent',actor:'op',spec_hash:specHash,packet_hash:second,...binding()});
  const rows=s.db.prepare("SELECT * FROM stage_posts WHERE kind IN ('decision','spec') AND snapshot_hash IS NOT NULL").all();
  const collision=rows.filter(row=>rows.some(other=>other.post_id!==row.post_id && other.snapshot_hash===row.snapshot_hash));
  assert.equal(collision.length,2);
  for (const [i,row] of collision.entries()) {
    const from={kind:'snapshot',post_id:row.post_id,hash:row.snapshot_hash}, point=s.forkPoint('item',from,undefined,{extended:true});
    s.append(`fork-${i}`,{type:'forked',actor:'peer',...point,from,seed_policy:2,rules:3,reason:'A separate follow-up.',at:stamp},{idem:`fork-${i}`});
    assert.equal(s.events(`fork-${i}`)[0].from.post_id,row.post_id);
  }
  assert.ok(s.verifyAll().every(row=>row.ok));
});

test('snapshot fork selection requires the matching hash and post identity', t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash, old = binding();
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['Find it'], out_of_scope: [], ...old });
  const snapshot = s.db.prepare('SELECT snapshot_hash FROM stage_posts WHERE post_id=?').get(old.post_id).snapshot_hash;
  assert.ok(s.forkPoint('item', { kind: 'snapshot', hash: snapshot, post_id: old.post_id }));
  assert.throws(() => s.forkPoint('item', { kind: 'snapshot', hash: snapshot, post_id: binding().post_id }), /fork selection/);
});

test('current SPEC identity cannot authorize a comment on a frozen SEE anchor', t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash, old = binding();
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['Find it'], out_of_scope: [], ...old });
  const current = binding();
  assert.throws(() => append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'see', anchor_hash: see,
    comment: 'Attempt to reopen frozen SEE.', ...current }), /frozen or superseded/);
  assert.equal(s.events('item').filter(event => event.type === 'commented').length, 0);
});

test('a returned SPEC with the same content hash cannot reply to the old SPEC post', t => {
  const { s, append, binding } = setup(t), see = s.read('item').context.seeHash;
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['Find it'], out_of_scope: [], ...binding() });
  const spec = s.read('item').context.specHash, original = binding();
  append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'spec', anchor_hash: spec, comment: 'Original SPEC discussion.', ...original });
  const parent = s.events('item').at(-1).body_hash;
  const packet = s.putArtifact('item', JSON.stringify({ specHash: spec }));
  append({ type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet, ...binding() });
  append({ type: 'returned', actor: 'leader', reason: 'Please clarify the test.', spec_hash: spec, packet_hash: packet, ...binding() });
  const current = binding();
  assert.notEqual(current.post_id, original.post_id);
  assert.equal(current.post_version, spec);
  assert.throws(() => append({ type: 'commented', actor: 'peer', kind: 'comment', anchor_kind: 'spec', anchor_hash: spec,
    parent, comment: 'Reply to frozen discussion.', ...current }), /parent belongs to a frozen post/);
});

test('steward can credit a frozen SEE comment in the active SPEC without changing its snapshot', async t => {
  const { Readable } = await import('node:stream');
  const { Auth } = await import('../app/auth.js');
  const { createHandler } = await import('../app/http.js');
  const s = new Store(); t.after(() => s.close()); const auth = new Auth(s);
  for (const id of ['op', 'peer']) await auth.createUser(id, 'synthetic-long-password-9', false);
  const handler = createHandler({ store: s, auth, secure: false, origin: 'http://localhost' });
  const call = async (path, input, headers = {}) => {
    const req = Readable.from([JSON.stringify(input)]); req.method = 'POST'; req.url = path;
    req.headers = { 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, writeHead(code,h={}) { this.status=code; Object.assign(this.headers,h); }, end(v='') { this.text+=v; } };
    await handler(req,res); return res;
  };
  const login = async id => { const r = await call('/api/login', { id, password: 'synthetic-long-password-9' });
    return { cookie: r.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': JSON.parse(r.text).csrf }; };
  const op = await login('op'), peer = await login('peer');
  const created = await call('/api/items', { original: 'The handoff loses context.' }, op);
  assert.equal(created.status, 201); const id = JSON.parse(created.text).id;
  const initial = s.read(id).context;
  const bind = (headers, post) => ({ ...headers, 'x-post-id': post.id, 'x-post-version': post.version });
  const peerSee = bind(peer, initial.activePost), opSee = bind(op, initial.activePost);
  const quote = 'Keep the caller note visible.';
  assert.equal((await call(`/api/items/${id}/events`, { type: 'commented', kind: 'comment', anchor_kind: 'see', anchor_hash: initial.seeHash, comment: quote }, peerSee)).status, 201);
  const source = s.events(id).at(-1).body_hash;
  assert.equal((await call(`/api/items/${id}/events`, { type: 'specced', see_hash: initial.seeHash, must: ['Keep the handoff'], how_we_know: ['Review it'], out_of_scope: [] }, opSee)).status, 201);
  const frozen = s.db.prepare('SELECT * FROM stage_posts WHERE post_id=?').get(initial.activePost.id);
  const snapshotEvents = s.events(id).slice(0, frozen.closed_seq);
  const current = s.read(id).context, opSpec = bind(op, current.activePost), peerSpec = bind(peer, current.activePost);
  const get = async (path, headers) => {
    const req = Readable.from([]); req.method = 'GET'; req.url = path; req.headers = headers; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, writeHead(code,h={}) { this.status=code; Object.assign(this.headers,h); }, end(v='') { this.text+=v; } };
    await handler(req,res); return res;
  };
  const sourceUrl = `/items/${id}/spec?source_comment=${source}`;
  assert.match((await get(sourceUrl, op)).text, /data-include="historical-spec"/);
  assert.doesNotMatch((await get(sourceUrl, peer)).text, /data-include="historical-spec"/);
  const update = { type: 'specced', see_hash: initial.seeHash, base_spec_hash: current.specHash, must: ['Keep the handoff', quote], how_we_know: ['Review it'], out_of_scope: [], credits: [{ comment: source, mode: 'quoted' }] };
  assert.equal((await call(`/api/items/${id}/events`, update, opSee)).status, 409, 'the old target is still frozen');
  assert.equal((await call(`/api/items/${id}/events`, update, peerSpec)).status, 409, 'only the steward can adopt');
  assert.equal((await call(`/api/items/${id}/events`, { ...update, must: ['A different sentence'] }, opSpec)).status, 409, 'quoted credit must be verbatim');
  assert.equal((await call(`/api/items/${id}/events`, { ...update, credits: [{ comment: 'a'.repeat(64), mode: 'paraphrased' }] }, opSpec)).status, 409, 'credit must name a comment in this item');
  assert.equal((await call(`/api/items/${id}/events`, update, opSpec)).status, 201);
  const event = s.events(id).at(-1); assert.deepEqual(event.credits, [{ comment: source, mode: 'quoted' }]);
  assert.deepEqual(s.db.prepare('SELECT * FROM stage_posts WHERE post_id=?').get(initial.activePost.id), frozen);
  assert.deepEqual(s.events(id).slice(0, frozen.closed_seq), snapshotEvents);
  s.erase(id, source, 'peer', stamp);
  assert.doesNotMatch((await get(sourceUrl, op)).text, /data-include="historical-spec"/);
  const after = s.read(id).context;
  const erased = { ...update, base_spec_hash: after.specHash };
  assert.equal((await call(`/api/items/${id}/events`, erased, bind(op, after.activePost))).status, 409, 'erased sources cannot be credited');
  const restored = new Store(); t.after(() => restored.close());
  restored.importJsonl(s.exportJsonl());
  assert.ok(restored.verifyAll().every(row => row.ok), 'historical adopted credit remains replayable after erasure');
});
