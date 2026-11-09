import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fold, initial, step } from './machine.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};
const eventHash = (prev, seq, type, actor, bodyHash, at) =>
  digest(stable({ prev, seq, type, actor, bodyHash, at }));
const scopedBodyHash = (item, bytes) => digest(`${item}\0${bytes}`);
// The idempotency key is part of the hash so a forged key is caught by verify.
const submittedEventHash = (event, idem) => digest(stable({ idem, event }));

function bodyOf(event) {
  const body = { ...event };
  delete body.type;
  delete body.actor;
  delete body.at;
  return body;
}

export class Store {
  constructor(file = ':memory:') {
    if (file !== ':memory:' && file !== '') {
      // The database holds event bodies and token digests: owner-only from the first byte.
      closeSync(openSync(file, 'a', 0o600));
      chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actors(
        id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run')),
        leader INTEGER DEFAULT 0, item TEXT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        item TEXT, seq INTEGER, type TEXT, actor TEXT, body_hash TEXT,
        prev_hash TEXT, hash TEXT, at TEXT, idem TEXT, submitted_hash TEXT,
        PRIMARY KEY(item,seq), UNIQUE(item,idem)
      );
      CREATE TABLE IF NOT EXISTS bodies(hash TEXT PRIMARY KEY, bytes TEXT);
      CREATE TABLE IF NOT EXISTS items(
        item TEXT PRIMARY KEY, state TEXT, head TEXT, seq INTEGER, context TEXT
      );`);
    try { this.db.exec('ALTER TABLE items ADD COLUMN context TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE events ADD COLUMN submitted_hash TEXT'); } catch {}
    this.backfillSubmittedHashes();
  }

  backfillSubmittedHashes() {
    const rows = this.db.prepare(`SELECT e.* FROM events e
      JOIN bodies b ON b.hash=e.body_hash WHERE e.submitted_hash IS NULL`).all();
    const fill = this.db.prepare('UPDATE events SET submitted_hash=? WHERE item=? AND seq=?');
    for (const row of rows) fill.run(submittedEventHash(this.submittedEventFromRow(row), row.idem), row.item, row.seq);
  }

  registerPerson(id, { leader = false } = {}) {
    if (!id) throw new Error('person id required');
    this.db.prepare(`INSERT INTO actors(id,kind,leader,item) VALUES(?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET kind='person', leader=excluded.leader, item=NULL`)
      .run(id, 'person', leader ? 1 : 0);
  }

  registerToken(id, { kind, item } = {}) {
    if (!id || !['gateway', 'run'].includes(kind) || !item) {
      throw new Error('token id, kind, and item required');
    }
    this.db.prepare(`INSERT INTO actors(id,kind,leader,item) VALUES(?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, leader=0, item=excluded.item`)
      .run(id, kind, item);
  }

  actor(id, item) {
    const row = this.db.prepare('SELECT id,kind,leader,item FROM actors WHERE id=?').get(id);
    if (!row) throw new Error('unknown actor');
    if (row.kind !== 'person' && row.item !== item) throw new Error('token is scoped to another item');
    return { kind: row.kind, leader: row.leader === 1 };
  }

  eventRows(item) {
    return this.db.prepare('SELECT * FROM events WHERE item=? ORDER BY seq').all(item);
  }

  eventFromRow(row) {
    const bytes = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash)?.bytes;
    return { ...(bytes ? JSON.parse(bytes) : {}), type: row.type, actor: row.actor,
      body_hash: row.body_hash, at: row.at };
  }

  submittedEventFromRow(row) {
    const bytes = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash)?.bytes;
    if (!bytes) return null;
    return { ...JSON.parse(bytes), type: row.type, actor: row.actor, at: row.at };
  }

  events(item) { return this.eventRows(item).map(row => this.eventFromRow(row)); }

  read(item) { return fold(this.events(item), actor => this.actor(actor, item)); }

  cache(item) {
    const row = this.db.prepare('SELECT context FROM items WHERE item=?').get(item);
    return row?.context ? JSON.parse(row.context) : initial();
  }

  ensureEvent(item, event) {
    if (!item || !event?.type || !event.actor) throw new Error('item, event, and actor required');
    if (Object.hasOwn(event, 'role')) throw new Error('event role is forbidden');
    if (typeof event.at !== 'string' || !event.at) throw new Error('event.at required');
    this.actor(event.actor, item);
    if (event.type === 'steward_changed') {
      const next = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(event.steward);
      if (!next || next.kind !== 'person') throw new Error('steward must be a registered person');
    }
  }

  append(item, event, options = {}) {
    if (!options.idem) throw new Error('idem required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const answer = this.appendInTransaction(item, event, options);
      this.db.exec('COMMIT');
      return answer;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  appendInTransaction(item, event, { expectedSeq, idem }) {
    this.ensureEvent(item, event);
    const submittedHash = submittedEventHash(event, idem);
    const existing = this.db.prepare('SELECT * FROM events WHERE item=? AND idem=?').get(item, idem);
    if (existing) {
      const storedEvent = this.submittedEventFromRow(existing);
      const existingHash = existing.submitted_hash || (storedEvent && submittedEventHash(storedEvent, existing.idem));
      if (!existingHash) throw new Error('idempotency record cannot be compared');
      if (existingHash !== submittedHash) {
        throw new Error('idempotency key reused with a different event');
      }
      if (!existing.submitted_hash) {
        this.db.prepare('UPDATE events SET submitted_hash=? WHERE item=? AND seq=?')
          .run(existingHash, item, existing.seq);
      }
      return { idempotent: true, seq: existing.seq, ...this.read(item) };
    }
    const cached = this.db.prepare('SELECT * FROM items WHERE item=?').get(item);
    const currentSeq = cached?.seq || 0;
    if (expectedSeq !== undefined && expectedSeq !== currentSeq) throw new Error('stale expectedSeq');
    const bytes = stable(bodyOf(event));
    const hashOfBody = scopedBodyHash(item, bytes);
    const prior = this.events(item);
    const priorState = fold(prior, actor => this.actor(actor, item)).context;
    const outcome = step(priorState, { ...event, body_hash: hashOfBody }, this.actor(event.actor, item));
    if (outcome.refusal) throw new Error(outcome.refusal);
    const seq = currentSeq + 1;
    const previous = cached?.head || '';
    const hash = eventHash(previous, seq, event.type, event.actor, hashOfBody, event.at);
    this.db.prepare('INSERT OR IGNORE INTO bodies(hash,bytes) VALUES(?,?)').run(hashOfBody, bytes);
    this.db.prepare(`INSERT INTO events(item,seq,type,actor,body_hash,prev_hash,hash,at,idem,submitted_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(item, seq, event.type, event.actor, hashOfBody, previous, hash, event.at, idem, submittedHash);
    this.db.prepare(`INSERT INTO items(item,state,head,seq,context) VALUES(?,?,?,?,?)
      ON CONFLICT(item) DO UPDATE SET state=excluded.state,head=excluded.head,
      seq=excluded.seq,context=excluded.context`)
      .run(item, outcome.state, hash, seq, stable(outcome.context));
    return { seq, hash, ...this.read(item), effects: outcome.effects };
  }

  verify(item) {
    const rows = this.eventRows(item);
    const erased = new Set();
    for (const row of rows.filter(row => row.type === 'erased')) {
      const bytes = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash)?.bytes;
      if (bytes) erased.add(JSON.parse(bytes).body_hash);
    }
    let previous = '';
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.seq !== index + 1) return { ok: false, seq: row.seq, reason: 'sequence' };
      const body = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash);
      if (body && scopedBodyHash(item, body.bytes) !== row.body_hash) {
        return { ok: false, seq: row.seq, reason: 'body' };
      }
      if (!body && !erased.has(row.body_hash)) return { ok: false, seq: row.seq, reason: 'body' };
      // An erased body cannot be re-hashed, but its receipt is in the chain.
      if (body && submittedEventHash(this.submittedEventFromRow(row), row.idem) !== row.submitted_hash) {
        return { ok: false, seq: row.seq, reason: 'submission' };
      }
      const hash = eventHash(previous, row.seq, row.type, row.actor, row.body_hash, row.at);
      if (row.prev_hash !== previous || row.hash !== hash) {
        return { ok: false, seq: row.seq, reason: 'chain' };
      }
      previous = row.hash;
    }
    return { ok: true };
  }

  // Every item that has events or a cache row: orphaned events cannot hide, and the
  // cache must equal a full replay.
  verifyAll() {
    const names = new Set([
      ...this.db.prepare('SELECT DISTINCT item FROM events').all().map(row => row.item),
      ...this.db.prepare('SELECT item FROM items').all().map(row => row.item),
    ]);
    return [...names].sort().map(item => {
      const chain = this.verify(item);
      if (!chain.ok) return { item, ...chain };
      const cache = this.db.prepare('SELECT * FROM items WHERE item=?').get(item);
      if (!cache) return { item, ok: false, reason: 'cache-missing' };
      const replay = this.read(item);
      if (replay.refusal) return { item, ok: false, reason: 'state' };
      const last = this.eventRows(item).at(-1);
      const same = cache.head === (last?.hash || '') && cache.seq === (last?.seq || 0)
        && cache.state === replay.state && cache.context === stable(replay.context);
      return same ? { item, ok: true } : { item, ok: false, reason: 'cache' };
    });
  }

  rebuild() {
    this.db.exec('DELETE FROM items');
    for (const { item } of this.db.prepare('SELECT DISTINCT item FROM events').all()) {
      const outcome = this.read(item);
      const last = this.eventRows(item).at(-1);
      this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?)').run(
        item, outcome.state, last?.hash || '', last?.seq || 0, stable(outcome.context),
      );
    }
  }

  erase(item, targetHash, actor, at) {
    if (!targetHash || !actor || typeof at !== 'string' || !at) throw new Error('erase arguments required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const target = this.db.prepare('SELECT 1 FROM events WHERE item=? AND body_hash=?').get(item, targetHash);
      if (!target) throw new Error('body is not part of item');
      const current = this.db.prepare('SELECT seq FROM items WHERE item=?').get(item);
      this.appendInTransaction(item, { type: 'erased', actor, body_hash: targetHash, at }, {
        expectedSeq: current?.seq || 0, idem: `erase:${targetHash}`,
      });
      // The receipt commits before deletion so a missing body remains explainable.
      this.db.prepare('DELETE FROM bodies WHERE hash=?').run(targetHash);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  exportJsonl() {
    const rows = this.db.prepare(`SELECT e.*,b.bytes FROM events e LEFT JOIN bodies b ON b.hash=e.body_hash
      ORDER BY e.item,e.seq`).all();
    const lines = rows.map(row => JSON.stringify(row));
    lines.push(JSON.stringify({ complete: true, events: rows.length }));
    return `${lines.join('\n')}\n`;
  }

  importJsonl(text) {
    const lines = text.trim() ? text.trim().split('\n').map(JSON.parse) : [];
    const footer = lines.pop();
    if (!footer?.complete || footer.events !== lines.length) throw new Error('incomplete import');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of lines) this.importRow(row);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  importRow(row) {
    if (!row.bytes || scopedBodyHash(row.item, row.bytes) !== row.body_hash) throw new Error('bad import body');
    if (eventHash(row.prev_hash, row.seq, row.type, row.actor, row.body_hash, row.at) !== row.hash) {
      throw new Error('bad import chain');
    }
    const existing = this.db.prepare('SELECT * FROM events WHERE item=? AND idem=?').get(row.item, row.idem);
    if (existing) {
      const { bytes, submitted_hash: incomingSubmittedHash, ...stored } = row;
      const { submitted_hash: existingSubmittedHash, ...incoming } = existing;
      const hash = incomingSubmittedHash || submittedEventHash({ ...JSON.parse(row.bytes), type: row.type, actor: row.actor, at: row.at }, row.idem);
      if (stable(incoming) !== stable(stored) || (existingSubmittedHash && existingSubmittedHash !== hash)) {
        throw new Error('conflicting import');
      }
      return;
    }
    const head = this.db.prepare('SELECT head,seq FROM items WHERE item=?').get(row.item);
    if (row.prev_hash !== (head?.head || '') || row.seq !== (head?.seq || 0) + 1) {
      throw new Error('import is not next in chain');
    }
    const event = { ...JSON.parse(row.bytes), type: row.type, actor: row.actor, at: row.at };
    if (row.submitted_hash && row.submitted_hash !== submittedEventHash(event, row.idem)) {
      throw new Error('bad import event');
    }
    const answer = this.appendInTransaction(row.item, event, { expectedSeq: row.seq - 1, idem: row.idem });
    if (answer.hash !== row.hash) throw new Error('import hash differs');
  }

  close() { this.db.close(); }
}
