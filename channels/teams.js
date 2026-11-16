import { createHmac, timingSafeEqual } from 'node:crypto';
import { refused } from '../core/errors.js';
import { captureCandidate, confirmCase, routeContribution, receiveSignedAction, recordSourceChange } from './adapter.js';

const WINDOW = 5 * 60_000;
const equal = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); };
const bytesOf = activity => {
  const body = { ...activity }; delete body.signature;
  return Buffer.from(JSON.stringify(body));
};
export const teamsSignature = (secret, timestamp, nonce, body) => createHmac('sha256', secret).update(`${timestamp}.${nonce}.`).update(body).digest('hex');

// Synthetic transport only. Production validation is Entra ID/Bot Framework JWT validation, not this HMAC seam.
export function verifyTeamsPayload(store, activity, { secret = process.env.SSS_TEAMS_CHANNEL_SECRET, clock = Date.now } = {}) {
  const timestamp = Number(activity.timestamp), nonce = activity.nonce, body = bytesOf(activity);
  if (!secret || !Number.isSafeInteger(timestamp) || typeof nonce !== 'string' || nonce.length < 8 || Math.abs(clock() - timestamp) > WINDOW
    || !equal(teamsSignature(secret, String(activity.timestamp), nonce, body), activity.signature)) throw refused('channel action refused');
  const tenantId = activity.tenantId;
  if (typeof tenantId !== 'string' || !tenantId) throw refused('channel action refused');
  store.db.prepare('DELETE FROM channel_nonces WHERE expires<=?').run(clock());
  const nonceResult = store.db.prepare('INSERT OR IGNORE INTO channel_nonces(channel,tenant_id,nonce,expires) VALUES(?,?,?,?)').run('teams', tenantId, nonce, clock() + WINDOW);
  if (nonceResult.changes !== 1) throw refused('channel action refused');
}

export function handleTeamsActivity(store, activity, options = {}) {
  verifyTeamsPayload(store, activity, options);
  const base = { channel: 'teams', tenantId: activity.tenantId, teamId: activity.teamId, externalUserId: activity.from?.id, externalEventId: activity.id };
  if (!base.teamId || !base.externalUserId || !base.externalEventId || activity.from?.guest === true) throw refused('channel action refused');
  if (activity.type === 'messageAction' && activity.action === 'See it') {
    return captureCandidate(store, { ...base, text: activity.message?.text, sourceMessageId: activity.message?.id, sourceVersion: activity.message?.version, audience: activity.message?.audience || [] }, options);
  }
  if (activity.type === 'adaptiveCard' && activity.action === 'confirmSee') {
    return confirmCase(store, { ...base, candidateId: activity.candidateId, item: activity.item }, options);
  }
  if (activity.type === 'message' && activity.mention === 'sss' && activity.replyTo?.item) {
    return routeContribution(store, { ...base, item: activity.replyTo.item, comment: activity.text, anchorKind: activity.replyTo.anchorKind, anchorHash: activity.replyTo.anchorHash }, options);
  }
  if (activity.type === 'adaptiveCard' && activity.action === 'signedAction') {
    return receiveSignedAction(store, { ...base, item: activity.item, event: activity.event }, options);
  }
  if (activity.type === 'messageChange' && ['edited', 'deleted'].includes(activity.change)) {
    return recordSourceChange(store, { ...base, sourceMessageId: activity.message?.id, sourceVersion: activity.message?.version, sourceHash: activity.message?.hash, change: activity.change }, options);
  }
  throw refused('channel action refused');
}
