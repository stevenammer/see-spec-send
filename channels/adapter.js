import { createHash } from 'node:crypto';
import { refused } from '../core/errors.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value ?? {});
const at = clock => new Date(clock()).toISOString();
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 4000;

function receipt(store, input) {
  const prior = store.db.prepare(`SELECT * FROM external_events WHERE channel=? AND tenant_id=? AND team_id=? AND external_event_id=?`)
    .get(input.channel, input.tenantId, input.teamId, input.externalEventId);
  if (prior) return { row: prior, duplicate: true };
  const result = store.db.prepare(`INSERT INTO external_events(channel,tenant_id,team_id,external_event_id,kind,status,item,person,source_message_id,source_version,source_hash,audience,payload,detail,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.channel, input.tenantId, input.teamId, input.externalEventId,
    input.kind, input.status, input.item ?? null, input.person ?? null, input.sourceMessageId ?? null,
    input.sourceVersion ?? null, input.sourceHash ?? null, json(input.audience || []), input.payload || '', json(input.detail), input.createdAt);
  return { row: store.db.prepare('SELECT * FROM external_events WHERE id=?').get(result.lastInsertRowid), duplicate: false };
}

function mapped(store, { channel = 'teams', tenantId, teamId, externalUserId }) {
  const team = store.db.prepare('SELECT enabled,revoked FROM channel_teams WHERE channel=? AND tenant_id=? AND team_id=?').get(channel, tenantId, teamId);
  const identity = store.db.prepare('SELECT person,enabled FROM channel_identities WHERE channel=? AND tenant_id=? AND external_user_id=?').get(channel, tenantId, externalUserId);
  if (!team || team.enabled !== 1 || team.revoked === 1 || !identity || identity.enabled !== 1) throw refused('channel action refused');
  store.actor(identity.person);
  return identity.person;
}

function assertReadable(store, person, item) {
  if (!store.canRead(person, item)) throw refused('channel action refused');
}

function activeBinding(store, item) {
  const post = store.read(item).context.activePost;
  if (!post) throw refused('channel action refused');
  return { post_id: post.id, post_version: post.version };
}

// These functions are the channel contract. They deliberately delegate canonical writes to Store.append.
export function resolveExternalIdentity(store, input) { return mapped(store, input); }

export function captureCandidate(store, input, { clock = Date.now } = {}) {
  const person = mapped(store, input);
  if (!valid(input.text) || !valid(input.sourceMessageId) || !valid(input.sourceVersion) || !Array.isArray(input.audience)) throw refused('channel action refused');
  if (input.audience.length && !input.audience.every(group => typeof group === 'string' && store.db.prepare('SELECT 1 FROM groups WHERE name=?').get(group))) throw refused('channel action refused');
  if (input.audience.length && !input.audience.some(group => store.db.prepare('SELECT 1 FROM group_members WHERE group_name=? AND person=?').get(group, person))) throw refused('channel action refused');
  const value = receipt(store, { ...input, person, kind: 'capture_candidate', status: 'previewed', payload: input.text,
    sourceHash: hash(input.text), createdAt: at(clock) });
  return { candidateId: value.row.id, duplicate: value.duplicate, preview: { text: input.text, audience: input.audience, sourceMessageId: input.sourceMessageId, sourceVersion: input.sourceVersion } };
}

export function confirmCase(store, input, { clock = Date.now } = {}) {
  const person = mapped(store, input);
  const candidate = store.db.prepare("SELECT * FROM external_events WHERE id=? AND channel=? AND tenant_id=? AND team_id=? AND person=? AND kind='capture_candidate'")
    .get(input.candidateId, input.channel, input.tenantId, input.teamId, person);
  if (!candidate) throw refused('channel action refused');
  const received = receipt(store, { ...input, person, kind: 'capture_confirm', status: 'received', payload: candidate.payload, sourceMessageId: candidate.source_message_id,
    sourceVersion: candidate.source_version, sourceHash: candidate.source_hash, audience: JSON.parse(candidate.audience), createdAt: at(clock) });
  if (received.duplicate) return { item: received.row.item, duplicate: true };
  if (candidate.status !== 'previewed') throw refused('channel action refused');
  const item = input.item;
  if (!valid(item)) throw refused('channel action refused');
  try {
    store.append(item, { type: 'posted', actor: person, rules: 3, original: candidate.payload, audience: JSON.parse(candidate.audience), at: at(clock) }, { idem: `channel:${input.channel}:${input.tenantId}:${input.teamId}:${input.externalEventId}` });
    store.db.prepare("UPDATE external_events SET status='captured',item=? WHERE id IN (?,?)").run(item, candidate.id, received.row.id);
    return { item, duplicate: false };
  } catch (error) {
    store.db.prepare("UPDATE external_events SET status='refused',detail=? WHERE id=?").run(json({ pointer: null }), received.row.id);
    throw error;
  }
}

export function routeContribution(store, input, { clock = Date.now } = {}) {
  const person = mapped(store, input); assertReadable(store, person, input.item);
  const received = receipt(store, { ...input, person, kind: 'contribution', status: 'received', payload: input.comment, createdAt: at(clock) });
  if (received.duplicate) return { duplicate: true, status: received.row.status };
  try {
    const binding = activeBinding(store, input.item);
    store.append(input.item, { type: 'commented', actor: person, kind: input.kind || 'comment', anchor_kind: input.anchorKind || store.read(input.item).context.activePost.kind,
      anchor_hash: input.anchorHash || binding.post_version, comment: input.comment, ...binding, at: at(clock) }, { idem: `channel:${input.channel}:${input.tenantId}:${input.teamId}:${input.externalEventId}` });
    store.db.prepare("UPDATE external_events SET status='routed' WHERE id=?").run(received.row.id);
    return { duplicate: false, status: 'routed' };
  } catch (error) {
    const active = store.read(input.item).context.activePost;
    store.db.prepare("UPDATE external_events SET status='queued',detail=? WHERE id=?").run(json({ pointer: active ? { post_id: active.id, post_version: active.version } : null }), received.row.id);
    return { duplicate: false, status: 'queued', pointer: active || null };
  }
}

export function receiveSignedAction(store, input, { clock = Date.now } = {}) {
  const person = mapped(store, input); assertReadable(store, person, input.item);
  const received = receipt(store, { ...input, person, kind: 'signed_action', status: 'received', payload: json(input.event), createdAt: at(clock) });
  if (received.duplicate) return { duplicate: true, status: received.row.status };
  try {
    const binding = activeBinding(store, input.item);
    const event = { ...binding, ...input.event, actor: person, at: at(clock) };
    store.append(input.item, event, { idem: `channel:${input.channel}:${input.tenantId}:${input.teamId}:${input.externalEventId}` });
    store.db.prepare("UPDATE external_events SET status='accepted' WHERE id=?").run(received.row.id);
    return { duplicate: false, status: 'accepted' };
  } catch {
    store.db.prepare("UPDATE external_events SET status='refused' WHERE id=?").run(received.row.id);
    throw refused('channel action refused');
  }
}

export function deliverDecisionRequest(store, input, options) { return delivery(store, 'decision_request', input, options); }
export function announceFreeze(store, input, options) { return delivery(store, 'freeze_notice', input, options); }
export function linkClosingReport(store, input, options) { return delivery(store, 'closing_report', input, options); }
function delivery(store, kind, input, { clock = Date.now } = {}) {
  mapped(store, input); assertReadable(store, input.person || mapped(store, input), input.item);
  const value = receipt(store, { ...input, kind, status: 'delivery_recorded', payload: json(input.payload), createdAt: at(clock) });
  return { duplicate: value.duplicate, status: value.row.status };
}

export function recordSourceChange(store, input, { clock = Date.now } = {}) {
  const person = mapped(store, input);
  const value = receipt(store, { ...input, person, kind: 'source_change', status: 'recorded', payload: '', sourceMessageId: input.sourceMessageId,
    sourceVersion: input.sourceVersion || '', sourceHash: input.sourceHash || '', createdAt: at(clock), detail: { change: input.change } });
  return { duplicate: value.duplicate, status: value.row.status };
}

export function disconnect(store, input) {
  store.db.prepare('UPDATE channel_teams SET enabled=0 WHERE channel=? AND tenant_id=? AND team_id=?').run(input.channel, input.tenantId, input.teamId);
}
export function revokeAccess(store, input) {
  store.db.prepare('UPDATE channel_teams SET enabled=0,revoked=1 WHERE channel=? AND tenant_id=? AND team_id=?').run(input.channel, input.tenantId, input.teamId);
  store.db.prepare('UPDATE channel_identities SET enabled=0 WHERE channel=? AND tenant_id=?').run(input.channel, input.tenantId);
}
