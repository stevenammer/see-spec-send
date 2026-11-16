import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { handleTeamsActivity, teamsSignature } from '../channels/teams.js';
import { disconnect, revokeAccess } from '../channels/adapter.js';

const now = 1_795_000_000_000;
const secret = 'synthetic-teams-signing-secret-12345';
const clock = () => now;
let serial = 0;

function fixture(t) {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('op'); store.registerPerson('peer'); store.registerPerson('leader', { leader: true }); store.registerPerson('outsider');
  store.groupCreate('Support', 'synthetic support group'); store.groupAdd('Support', 'op'); store.groupAdd('Support', 'peer'); store.groupAdd('Support', 'leader');
  for (const [external, person] of [['ext-op', 'op'], ['ext-peer', 'peer'], ['ext-leader', 'leader'], ['ext-outsider', 'outsider']]) {
    store.db.prepare('INSERT INTO channel_teams VALUES(?,?,?,?,?) ON CONFLICT(channel,tenant_id,team_id) DO NOTHING').run('teams', 'tenant-a', 'team-a', 1, 0);
    store.db.prepare('INSERT INTO channel_identities VALUES(?,?,?,?,?)').run('teams', 'tenant-a', external, person, 1);
  }
  return store;
}
function signed(input, from = 'ext-op') {
  const n = ++serial;
  const body = { ...input, id: input.id || `event-${n}`, timestamp: now, nonce: `nonce-${n}-long`, tenantId: 'tenant-a', teamId: 'team-a', from: { id: from } };
  body.signature = teamsSignature(secret, String(body.timestamp), body.nonce, Buffer.from(JSON.stringify(body)));
  return body;
}
function call(store, activity) { return handleTeamsActivity(store, activity, { secret, clock }); }
function capture(store, item = 'case') {
  const preview = signed({ type: 'messageAction', action: 'See it', message: { id: 'source-1', version: 'v1', text: 'Synthetic handoff note.', audience: ['Support'] } });
  const candidate = call(store, preview);
  const confirm = signed({ type: 'adaptiveCard', action: 'confirmSee', candidateId: candidate.candidateId, item });
  return { candidate, result: call(store, confirm) };
}
function binding(store, item) { const post = store.read(item).context.activePost; return { post_id: post.id, post_version: post.version }; }
function submitted(store, item) {
  const see = store.read(item).context.seeHash;
  store.append(item, { type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['Synthetic check'], out_of_scope: [], ...binding(store, item), at: new Date(now).toISOString() }, { idem: `${item}-spec` });
  const spec = store.read(item).context.specHash;
  const packet = store.putArtifact(item, JSON.stringify({ specHash: spec }));
  store.append(item, { type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet, ...binding(store, item), at: new Date(now).toISOString() }, { idem: `${item}-send` });
  return { spec, packet };
}

test('Teams capture is deliberate preview then confirmation, with frozen external receipt', t => {
  const store = fixture(t); const { candidate, result } = capture(store);
  assert.equal(candidate.preview.text, 'Synthetic handoff note.'); assert.equal(result.item, 'case');
  assert.equal(store.events('case')[0].actor, 'op'); assert.equal(store.events('case')[0].original, 'Synthetic handoff note.');
  const rows = store.db.prepare('SELECT kind,status,source_message_id,source_version,source_hash,audience,payload FROM external_events ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.kind), ['capture_candidate', 'capture_confirm']); assert.equal(rows[0].status, 'captured');
  assert.equal(rows[0].source_message_id, 'source-1'); assert.equal(rows[0].source_version, 'v1'); assert.equal(rows[0].source_hash.length, 64); assert.equal(rows[0].payload, 'Synthetic handoff note.');
});

test('Teams refuses forged identities, wrong tenants, guests, replayed nonces, and duplicate callbacks', t => {
  const store = fixture(t);
  const forged = signed({ type: 'messageAction', action: 'See it', message: { id: 'x', version: '1', text: 'Synthetic', audience: ['Support'] } }); forged.signature = '0'.repeat(64);
  assert.throws(() => call(store, forged), /channel action refused/);
  const wrongTenant = signed({ type: 'messageAction', action: 'See it', message: { id: 'x', version: '1', text: 'Synthetic', audience: ['Support'] } }); wrongTenant.tenantId = 'tenant-b';
  assert.throws(() => call(store, wrongTenant), /channel action refused/);
  const guest = signed({ type: 'messageAction', action: 'See it', message: { id: 'x', version: '1', text: 'Synthetic', audience: ['Support'] } }); guest.from.guest = true;
  assert.throws(() => call(store, guest), /channel action refused/);
  const activity = signed({ type: 'messageAction', action: 'See it', message: { id: 'x', version: '1', text: 'Synthetic', audience: ['Support'] } }); call(store, activity);
  assert.throws(() => call(store, activity), /channel action refused/);
  const { candidateId } = call(store, signed({ type: 'messageAction', action: 'See it', message: { id: 'y', version: '1', text: 'Synthetic 2', audience: ['Support'] } }));
  const confirm = signed({ type: 'adaptiveCard', action: 'confirmSee', candidateId, item: 'once', id: 'same-callback' });
  assert.equal(call(store, confirm).duplicate, false);
  const retry = { ...confirm, nonce: `nonce-retry-${++serial}-long` }; delete retry.signature; retry.signature = teamsSignature(secret, String(retry.timestamp), retry.nonce, Buffer.from(JSON.stringify(retry)));
  assert.equal(call(store, retry).duplicate, true); assert.equal(store.events('once').length, 1);
});

test('Teams uses Store authority, exact packet binding, stale cards, and frozen reply queueing', t => {
  const store = fixture(t); capture(store); const { spec, packet } = submitted(store, 'case');
  const denied = signed({ type: 'adaptiveCard', action: 'signedAction', item: 'case', event: { type: 'approved', spec_hash: spec, packet_hash: packet, reason: 'Synthetic independent review supports this bounded trial.', cap_usd: 1, quorum: 1 } }, 'ext-peer');
  assert.throws(() => call(store, denied), /channel action refused/);
  const wrongPacket = signed({ type: 'adaptiveCard', action: 'signedAction', item: 'case', event: { type: 'approved', spec_hash: spec, packet_hash: '0'.repeat(64), reason: 'Synthetic independent review supports this bounded trial.', cap_usd: 1, quorum: 1 } }, 'ext-leader');
  assert.throws(() => call(store, wrongPacket), /channel action refused/);
  const stale = signed({ type: 'adaptiveCard', action: 'signedAction', item: 'case', event: { type: 'approved', spec_hash: spec, packet_hash: packet, reason: 'Synthetic independent review supports this bounded trial.', cap_usd: 1, quorum: 1, post_version: '0'.repeat(64) } }, 'ext-leader');
  assert.throws(() => call(store, stale), /channel action refused/);
  store.append('case', { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'Synthetic independent review supports this bounded trial.', cap_usd: 1, quorum: 1, ...binding(store, 'case'), at: new Date(now).toISOString() }, { idem: 'native-approval' });
  const late = signed({ type: 'message', mention: 'sss', replyTo: { item: 'case', anchorKind: 'see', anchorHash: store.read('case').context.seeHash }, text: 'Late synthetic reply.' }, 'ext-peer');
  const answer = call(store, late); assert.equal(answer.status, 'queued'); assert.ok(answer.pointer);
});

test('source edits do not rewrite frozen text, restricted audiences reject outsiders, and disconnect blocks use', t => {
  const store = fixture(t); capture(store);
  const change = signed({ type: 'messageChange', change: 'edited', message: { id: 'source-1', version: 'v2', hash: 'new-source-hash' } });
  call(store, change); assert.equal(store.events('case')[0].original, 'Synthetic handoff note.');
  const leak = signed({ type: 'messageAction', action: 'See it', message: { id: 'private', version: '1', text: 'Synthetic private', audience: ['Support'] } }, 'ext-outsider');
  assert.throws(() => call(store, leak), /channel action refused/);
  disconnect(store, { channel: 'teams', tenantId: 'tenant-a', teamId: 'team-a' });
  const blocked = signed({ type: 'messageAction', action: 'See it', message: { id: 'z', version: '1', text: 'Synthetic', audience: ['Support'] } });
  assert.throws(() => call(store, blocked), /channel action refused/);
  revokeAccess(store, { channel: 'teams', tenantId: 'tenant-a', teamId: 'team-a' });
});

test('native forum and Teams capture produce equivalent canonical SEE events and refusals', t => {
  const teams = fixture(t), native = fixture(t); capture(teams, 'same');
  native.append('same', { type: 'posted', actor: 'op', rules: 3, original: 'Synthetic handoff note.', audience: ['Support'], at: new Date(now).toISOString() }, { idem: 'native' });
  assert.deepEqual(teams.events('same').map(event => ({ type: event.type, actor: event.actor, original: event.original, audience: event.audience })), native.events('same').map(event => ({ type: event.type, actor: event.actor, original: event.original, audience: event.audience })));
  const denied = signed({ type: 'message', mention: 'sss', replyTo: { item: 'same' }, text: 'No access.' }, 'ext-outsider');
  assert.throws(() => call(teams, denied), /channel action refused/); assert.equal(native.canRead('outsider', 'same'), false);
});
