import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Integrations, hmac } from '../app/integrations.js';

// Findings from running Cloudflare's open-source security-audit skill against this repo (Nov 17, 2026), each one
// checked by hand against the source before it was fixed. The audit was source-only; these tests are the execution.
class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}
async function call(handler, method, path, headers = {}, input = null) {
  const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path; req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, text: res.text, headers: res.headers };
}
async function world(t) {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  for (const id of ['sam', 'riya', 'pat']) await auth.createUser(id, `${id}-long-password-9x`, false);
  store.groupCreate('Reservations', 'night shift'); store.groupAdd('Reservations', 'sam'); store.groupAdd('Reservations', 'riya');
  store.append('secret', { type: 'posted', actor: 'sam', rules: 3, original: 'Private export problem for reservations only', audience: ['Reservations'], at: '2026-11-17T12:00:00.000Z' }, { idem: 'p' });
  store.append('open', { type: 'posted', actor: 'sam', rules: 3, original: 'An open workspace problem', audience: [], at: '2026-11-17T12:01:00.000Z' }, { idem: 'o' });
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const as = async id => {
    const login = await call(handler, 'POST', '/api/login', {}, { id, password: `${id}-long-password-9x` });
    return { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': JSON.parse(login.text).csrf };
  };
  return { store, handler, as };
}

test('the reconciliation report and transfer request follow the read scope like every other route', async t => {
  const { handler, as } = await world(t);
  const pat = await as('pat'), riya = await as('riya');
  assert.equal((await call(handler, 'GET', '/api/items/secret/reconciliation', pat)).status, 403, 'an outsider learns nothing, not even who the steward is');
  assert.equal((await call(handler, 'POST', '/api/items/secret/reconciliation/transfer-request', pat, { reason: 'I would like this one' })).status, 403);
  assert.equal((await call(handler, 'GET', '/api/items/secret/reconciliation', riya)).status, 200, 'a member of the audience still sees it');
  assert.equal((await call(handler, 'GET', '/api/items/open/reconciliation', pat)).status, 200, 'an unrestricted item is unchanged');
});

test('a restricted item cannot be forked into a workspace-wide copy', async t => {
  const { handler, store, as } = await world(t);
  const pat = await as('pat'), sam = await as('sam');
  const before = store.listItems().length;
  assert.equal((await call(handler, 'POST', '/api/items/secret/fork', pat, { reason: 'I want my own copy of this' })).status, 403, 'an outsider is refused');
  assert.equal(store.listItems().length, before, 'no copy of the private text was created');
  const made = await call(handler, 'POST', '/api/items/secret/fork', sam, { reason: 'I want my own copy of this' });
  assert.equal(made.status, 201, 'the steward can fork their own branch');
  const child = JSON.parse(made.text).id;
  assert.deepEqual(store.readScope(child).audience, ['Reservations'], 'the copy keeps the audience');
  assert.equal((await call(handler, 'GET', `/api/items/${child}`, pat)).status, 403, 'an outsider cannot read the copy');
});

test('a person’s contribution record leaves out work in groups the viewer is not in', async t => {
  const { store } = await world(t);
  const forPat = store.contributions('pat', 'sam').map(row => row.item);
  const forRiya = store.contributions('riya', 'sam').map(row => row.item);
  assert.ok(!forPat.includes('secret'), 'the outsider does not see the restricted item id');
  assert.ok(forPat.includes('open'), 'the open item is still listed');
  assert.ok(forRiya.includes('secret'), 'a member of the group sees it');
});

test('an inbound source is actually rate limited', async t => {
  const store = new Store(); t.after(() => store.close());
  const secret = 'this-is-a-long-test-secret'; let now = 9_000_000;
  const integrations = new Integrations(store, { clock: () => now });
  await integrations.addSource('slack', secret, 2);
  const send = n => { const bytes = Buffer.from(JSON.stringify({ problem: `Synthetic failure ${n}`, source_label: 'Synthetic Slack', honesty_label: 'reported' }));
    return () => integrations.receive('slack', String(now), hmac(secret, String(now), bytes), bytes, { 'idempotency-key': `rate-${n}` }); };
  await assert.doesNotReject(send(1)); await assert.doesNotReject(send(2));
  await assert.rejects(send(3), /inbound refused/, 'the third call in the same minute is refused');
  now += 60_000;
  await assert.doesNotReject(send(4), 'the allowance comes back with time');
});

test('workspace research never copies a restricted item’s text into an item that more people can read', async t => {
  const { store } = await world(t);
  store.append('wide', { type: 'posted', actor: 'sam', rules: 3, original: 'Export problem seen in the open', audience: [], at: '2026-11-17T12:02:00.000Z' }, { idem: 'w' });
  store.append('inner', { type: 'posted', actor: 'sam', rules: 3, original: 'Export problem seen by the group', audience: ['Reservations'], at: '2026-11-17T12:03:00.000Z' }, { idem: 'i' });
  store.db.prepare("INSERT OR REPLACE INTO research_config(source,enabled) VALUES('this_workspace',1)").run();
  const { workspaceRecords } = await import('../research/workspace.js');
  const toWide = workspaceRecords(store, 'sam', 'wide', 'Private export problem').map(row => row.item);
  assert.ok(!toWide.includes('secret'), 'restricted text stays out of a workspace-wide item');
  const toInner = workspaceRecords(store, 'sam', 'inner', 'Private export problem').map(row => row.item);
  assert.ok(toInner.includes('secret'), 'a same-audience item can still see it');
  assert.ok(workspaceRecords(store, 'sam', 'inner', 'open workspace problem').map(row => row.item).includes('open'), 'open sources still help restricted items');
});

test('the home feed page hides a restricted problem from people outside its audience, like the JSON list does', async t => {
  const { handler, as } = await world(t);
  const feedFor = async id => (await call(handler, 'GET', '/', { ...(await as(id)), accept: 'text/html' })).text;
  assert.doesNotMatch(await feedFor('pat'), /Private export problem for reservations only/, 'an outsider does not see the text');
  assert.match(await feedFor('riya'), /Private export problem for reservations only/, 'a member of the audience does');
  assert.match(await feedFor('pat'), /An open workspace problem/, 'open items still show');
});

test('a steward who has left the audience can no longer steer, send, research or draft on a restricted item', async t => {
  const { handler, store, as } = await world(t);
  store.groupRemove('Reservations', 'sam');
  const sam = await as('sam');
  for (const [path, body] of [['research', {}], ['spec-draft', {}], ['send', {}], ['steer', { instruction: 'Do something else entirely please' }], ['artifact', { html: '<p>x</p>' }]]) {
    const r = await call(handler, 'POST', `/api/items/secret/${path}`, sam, body);
    assert.equal(r.status, 403, `${path} refused once the steward is outside the audience`);
  }
  const open = await call(handler, 'POST', '/api/items/open/research', sam, {});
  assert.notEqual(open.status, 403, 'an open item is unaffected');
});

test('a failed provider call keeps its spend hold but stops blocking other calls once its timeout has passed', async t => {
  const { fixture, request } = await import('./helpers/gateway-fixture.mjs');
  const { Gateway } = await import('../gateway/http.js');
  let now = 1_800_000_000_000;
  const { store, ledger, token } = fixture(':memory:', { concurrency: 1, timeout_ms: 2000 }, 0.1, { clock: () => now });
  t.after(() => store.close());
  const gateway = new Gateway(ledger, () => { throw new Error('upstream rejected the request'); });
  assert.equal((await gateway.call(token, 'bad-1', request())).status, 202, 'the failure is an unresolved hold');
  assert.throws(() => ledger.reserve(token, 'too-soon', request()), /concurrency/, 'while it could still be running it holds the slot');
  now += 3_500;
  const held = ledger.receipts().reduce((n, row) => n + row.charged_micros, 0);
  assert.ok(held > 0, 'the money stays held until an operator releases it');
  assert.doesNotThrow(() => ledger.reserve(token, 'later', request()), 'after the timeout the slot is free again');
  assert.equal(ledger.receipts().reduce((n, row) => n + row.charged_micros, 0) >= held, true, 'and the earlier hold is still counted');
});

test('the Quest gateway counts every lane’s spend against the shared caps, analysis included', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../gateway/quest.js', import.meta.url), 'utf8');
  for (const lane of ['receipts()', 'effortReceipts()', 'analysisReceipts()']) assert.ok(source.includes(`this.ledger.${lane}`), `Quest adds up ${lane}`);
});

test('erasing wording also removes it from a built bundle that copied it, and an erased artifact is no longer served', () => {
  const store = new Store();
  try {
    const wording = 'The night export leaks card digits';
    const bundle = JSON.stringify({ sss_bundle: 1, manifest: { files: [] }, files: { 'index.html': Buffer.from(`<h1>${wording}</h1>`).toString('base64') } });
    const hash = 'ab'.repeat(32);
    store.db.prepare('INSERT INTO bodies(hash,bytes,erased) VALUES(?,?,0)').run(hash, bundle);
    const keep = store.db.prepare('INSERT INTO bodies(hash,bytes,erased) VALUES(?,?,0)');
    keep.run('cd'.repeat(32), JSON.stringify({ sss_bundle: 1, manifest: { files: [] }, files: { 'index.html': Buffer.from('<h1>Something else entirely</h1>').toString('base64') } }));
    assert.equal(store.redactStoredCopies({ original: wording }, 'ef'.repeat(32)), 1, 'exactly the bundle that quoted it is redacted');
    const row = store.db.prepare('SELECT bytes, erased FROM bodies WHERE hash=?').get(hash);
    assert.equal(row.erased, 1);
    assert.ok(!row.bytes.includes('sss_bundle') && !Buffer.from(row.bytes).toString().includes(wording));
    assert.equal(store.db.prepare('SELECT erased FROM bodies WHERE hash=?').get('cd'.repeat(32)).erased, 0, 'an unrelated bundle is left alone');
    assert.equal(store.artifactByHashPrefix(hash), null, 'an erased artifact is not served by the bundle origin');
  } finally { store.close(); }
});

test('the chat gateway refuses image, audio and file message parts it can’t meter, and still takes text parts', async () => {
  const { fixture, request } = await import('./helpers/gateway-fixture.mjs');
  const { ChatGateway } = await import('../gateway/http.js');
  const { store, ledger, token } = fixture(':memory:', { concurrency: 5 });
  try {
    const chat = parts => ({ model: ledger.rate.model, stream: false, messages: [{ role: 'user', content: parts }], max_tokens: 5 });
    const gateway = new ChatGateway(ledger, { chat: async () => ({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
    for (const part of [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'input_audio', input_audio: {} }, { type: 'file', file: {} }, null]) {
      await assert.rejects(() => gateway.call(token, `img-${Math.random().toString(36).slice(2)}`, chat([{ type: 'text', text: 'hi' }, part])), /invalid chat payload/);
    }
    await assert.doesNotReject(() => gateway.call(token, 'text-ok', chat([{ type: 'text', text: 'hi' }])));
  } finally { store.close(); }
});

test('a reanalysis update stops showing once a later group change would let people read text they couldn\u2019t read at its source', async () => {
  const { currentAnnexes } = await import('../reanalysis/read.js');
  const store = new Store(); const auth = new Auth(store);
  try {
    for (const id of ['sam', 'riya', 'pat']) await auth.createUser(id, `${id}-long-password-9x`, false);
    store.groupCreate('Reservations', 'night shift'); store.groupAdd('Reservations', 'sam'); store.groupAdd('Reservations', 'riya');
    store.groupCreate('Billing', 'billing team'); store.groupAdd('Billing', 'sam'); store.groupAdd('Billing', 'riya');
    store.append('secret', { type: 'posted', actor: 'sam', rules: 3, original: 'Private export problem for reservations only', audience: ['Reservations'], at: '2026-11-17T12:00:00.000Z' }, { idem: 'p' });
    store.append('target', { type: 'posted', actor: 'sam', rules: 3, original: 'Billing export problem seen by billing', audience: ['Billing'], at: '2026-11-17T12:04:00.000Z' }, { idem: 't' });
    // Everyone who can read the target (sam, riya) can also read the source, so the update is allowed when it is written.
    const at = '2026-11-17T13:00:00.000Z';
    const delta = store.knowledge.append('delta', { v: 1, source: { item: 'secret', seq: 1, event_hash: 'e'.repeat(64), body_hash: 'b'.repeat(64) }, trigger: 'x', claims: [{ text: 'Card digits appear in the night export.' }], provenance_roots: ['e'.repeat(64)], generation: 0 }, { at });
    store.knowledge.append('annex', { v: 1, parent: { item: 'target', post_id: 'p', snapshot_hash: 's', decision_hash: '' }, delta: delta.body_hash, what_is_new: ['Card digits appear in the night export.'], bears_on: [], why_matched: 'x', not_known: [], statement: 'Found by Effort (AI).', impact: 'x' }, { at });
    const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
    const login = await call(handler, 'POST', '/api/login', {}, { id: 'sam', password: 'sam-long-password-9x' });
    const sam = { cookie: login.headers['set-cookie'].split(';')[0], accept: 'text/html' };
    assert.equal(currentAnnexes(store, 'target').length, 1);
    assert.match((await call(handler, 'GET', '/items/target', sam)).text, /Card digits appear/, 'the item page shows the update to people who may read both');
    // An operator adds Pat to Billing. Pat can now read the target, but never could read the source.
    store.groupAdd('Billing', 'pat');
    assert.equal(currentAnnexes(store, 'target').length, 0, 'the update is hidden');
    assert.doesNotMatch((await call(handler, 'GET', '/items/target', sam)).text, /Card digits appear/, 'on the item page too, for everyone');
  } finally { store.close(); }
});

test('whoever hand-delivers a try cannot also say it helps, and a model-built try is unchanged', async () => {
  const { fixture, put } = await import('./helpers/gateway-fixture.mjs');
  const { store, run } = fixture();
  try {
    for (const id of ['cleo', 'dana', 'erin']) store.registerPerson(id);
    // A leader or steward uploads the page by hand: the run token's event carries who delivered it.
    put(store, 'tried', run.run_actor, { approval: run.approval, spec_hash: run.spec_hash, iteration: 0, artifact_hash: 'ab'.repeat(32), delivered_by: 'cleo' });
    assert.equal(store.read('item').state, 'TRYING');
    assert.ok(store.read('item').context.ineligibleHelpers.includes('cleo'), 'the deliverer is ineligible');
    assert.throws(() => put(store, 'helped', 'cleo', { artifact_hash: 'ab'.repeat(32) }), /not allowed/, 'the deliverer is refused');
    put(store, 'helped', 'dana', { artifact_hash: 'ab'.repeat(32) });
    assert.deepEqual(store.read('item').context.helpers, ['dana'], 'someone who didn’t shape it still counts');
  } finally { store.close(); }
});

test('the page route that takes a hand-delivered try refuses once the approval has expired', () => {
  const source = readFileSyncForTest('../app/http.js');
  assert.match(source, /state\.context\.leash\?\.expiresAt && clock\(\) >= Date\.parse\(state\.context\.leash\.expiresAt\)\) throw refused\('approval expired'\)/);
  assert.match(source, /if \(killed\(store\)\) throw refused\('system stopped'\)/);
});
import { readFileSync as readFileSyncImported } from 'node:fs';
function readFileSyncForTest(path) { return readFileSyncImported(new URL(path, import.meta.url), 'utf8'); }

test('an invite made for a named account only ever creates that account', async () => {
  const store = new Store(); const auth = new Auth(store);
  try {
    const named = auth.createInvite('member', Date.now() + 3_600_000, { forId: 'nick' });
    await assert.rejects(() => auth.redeem(named, 'steven2', 'steven2-long-password-9x'), /invite unavailable/, 'a different name is refused with the generic message');
    assert.equal(auth.listInvites().find(row => row.for === 'nick')?.status, 'open', 'and the invite is still open for the right person');
    await assert.doesNotReject(() => auth.redeem(named, 'nick', 'nick-long-password-9x'));
    const open = auth.createInvite('member');
    await assert.doesNotReject(() => auth.redeem(open, 'cleo', 'cleo-long-password-9x'), 'an unnamed invite still lets the redeemer pick');
    assert.throws(() => auth.createInvite('member', Date.now() + 1000, { forId: 'Bad Name!' }), /invalid account id/);
  } finally { store.close(); }
});

test('the older problem-and-verdict way of posting is closed by default, and posting the problem text still works', async t => {
  const { handler, as } = await world(t);
  const nick = await as('riya');
  const old = await call(handler, 'POST', '/api/items', nick, { problem: 'Queue backs up at noon', have: true, have_note: 'looked', verdict: 'build_needed' });
  assert.equal(old.status, 409); assert.match(old.text, /original/);
  const current = await call(handler, 'POST', '/api/items', nick, { original: 'Queue backs up at noon' });
  assert.equal(current.status, 201);
  assert.equal(JSON.parse(current.text).state.context.rules, 3, 'new items are on the current rule set');
});
