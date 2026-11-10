// The demo's event log. It follows core/store.js as far as a browser can:
// append-only, hash-chained with SHA-256, authority looked up from a fixed roster,
// and a verify that recomputes the whole chain. It keeps no rules of its own.
// Every decision about what may happen comes from the generated machine copy.
import { fold, initial, step } from './machine.js';

const encoder = new TextEncoder();

export const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};

export function createLog({ roster, item, now = () => new Date().toISOString(),
  subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw new Error('WebCrypto is not available');
  if (!roster || !item) throw new Error('roster and item required');
  const rows = [];

  const digest = async text => {
    const bytes = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(text)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const scopedHash = bytes => digest(`${item}\0${bytes}`);
  const submittedHash = (event, idem) => digest(stable({ idem, event }));
  const eventHash = (prev, seq, type, actor, bodyHash, at, authority) => {
    const event = { prev, seq, type, actor, bodyHash, at };
    if (authority) {
      event.actor_kind = authority.kind;
      event.actor_leader = authority.leader ? 1 : 0;
    }
    return digest(stable(event));
  };
  const bodyOf = event => {
    const body = { ...event };
    delete body.type; delete body.actor; delete body.at;
    return body;
  };
  const authorityOf = id => {
    const row = Object.hasOwn(roster, id) ? roster[id] : null;
    if (!row) throw new Error('unknown actor');
    if (row.kind !== 'person' && row.item !== item) throw new Error('token is scoped to another item');
    return { kind: row.kind, leader: row.leader === true };
  };
  const eventOf = row => ({ ...JSON.parse(row.bytes), type: row.type, actor: row.actor,
    body_hash: row.bodyHash, at: row.at });
  const submittedOf = row => ({ ...JSON.parse(row.bytes), type: row.type, actor: row.actor, at: row.at });
  const replayRows = list => fold(
    list.map(row => ({ ...eventOf(row), authority: { kind: row.actorKind, leader: row.actorLeader === 1 } })),
    (actor, event) => event.authority);

  const log = {
    get length() { return rows.length; },
    item,
    rows: () => rows.map(row => ({ ...row })),
    events: () => rows.map(eventOf),
    // The same replay the Store does: authority comes from the snapshot each event was accepted under.
    replay: () => (rows.length ? replayRows(rows) : { state: 'SEEN', context: initial(), effects: [] }),
    head: () => rows.at(-1)?.hash ?? '',
    hashArtifact: text => scopedHash(text),

    // Returns { ok: true, ... } or { ok: false, error, refused }. A refused event leaves no trace in the log.
    async append(event, { idem } = {}) {
      try {
        if (!idem) throw new Error('idem required');
        if (!event?.type || !event.actor) throw new Error('item, event, and actor required');
        if (Object.hasOwn(event, 'role')) throw new Error('event role is forbidden');
        if (typeof event.at !== 'string' || !event.at) throw new Error('event.at required');
        authorityOf(event.actor);
        const submitted = await submittedHash(event, idem);
        const existing = rows.find(row => row.idem === idem);
        if (existing) {
          if (existing.submittedHash !== submitted) throw new Error('idempotency key reused with a different event');
          return { ok: true, idempotent: true, seq: existing.seq, ...log.replay() };
        }
        const bytes = stable(bodyOf(event));
        const bodyHash = await scopedHash(bytes);
        const prior = log.replay();
        if (prior.refusal) throw new Error(`cannot append: replay refused: ${prior.refusal}`);
        const authority = authorityOf(event.actor);
        const outcome = step(prior.context, { ...event, body_hash: bodyHash }, authority);
        if (outcome.refusal) {
          const error = new Error(outcome.refusal);
          error.refused = true;
          throw error;
        }
        const seq = rows.length + 1;
        const prev = rows.at(-1)?.hash ?? '';
        const hash = await eventHash(prev, seq, event.type, event.actor, bodyHash, event.at, authority);
        rows.push({ seq, type: event.type, actor: event.actor, bodyHash, prev, hash, at: event.at, idem,
          submittedHash: submitted, actorKind: authority.kind, actorLeader: authority.leader ? 1 : 0, bytes });
        return { ok: true, seq, hash, ...log.replay(), effects: outcome.effects };
      } catch (error) {
        return { ok: false, error: error.message, refused: error.refused === true };
      }
    },

    // Recompute the whole chain from the stored rows.
    async verify() {
      let previous = '';
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row.seq !== index + 1) return { ok: false, seq: row.seq, reason: 'sequence' };
        if (await scopedHash(row.bytes) !== row.bodyHash) return { ok: false, seq: row.seq, reason: 'body' };
        if (await submittedHash(submittedOf(row), row.idem) !== row.submittedHash) {
          return { ok: false, seq: row.seq, reason: 'submission' };
        }
        const authority = { kind: row.actorKind, leader: row.actorLeader === 1 };
        const hash = await eventHash(previous, row.seq, row.type, row.actor, row.bodyHash, row.at, authority);
        if (row.prev !== previous || row.hash !== hash) return { ok: false, seq: row.seq, reason: 'chain' };
        previous = row.hash;
      }
      if (replayRows(rows).refusal) return { ok: false, seq: rows.length, reason: 'state' };
      return { ok: true, events: rows.length };
    },

    // For the "tamper with it" button: edits a stored event in place so verify can catch it.
    // Real code never does this. It exists so a visitor can see the chain notice.
    tamper(seq) {
      const row = rows[seq - 1];
      if (!row) return false;
      row.bytes = stable({ ...JSON.parse(row.bytes), tampered: true });
      return true;
    },

    toJSON: () => ({ item, rows: rows.map(row => ({ ...row })) }),
    now,
  };
  return log;
}

// Restore saved rows. They are only accepted if the chain verifies, so a hand-edited save is dropped.
export async function restoreLog(saved, options) {
  if (!saved || saved.item !== options.item || !Array.isArray(saved.rows) || saved.rows.length > 200) return null;
  const fresh = createLog(options);
  // Rebuild through the real append path: same events, same idempotency keys, same timestamps.
  try {
    for (const row of saved.rows) {
      const body = JSON.parse(row.bytes);
      const result = await fresh.append({ ...body, type: row.type, actor: row.actor, at: row.at }, { idem: row.idem });
      if (!result.ok) return null;
    }
  } catch { return null; }
  const same = JSON.stringify(fresh.rows()) === JSON.stringify(saved.rows);
  return same && (await fresh.verify()).ok ? fresh : null;
}
