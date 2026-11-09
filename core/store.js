import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fold, initial, step } from './machine.js';
const digest = x => createHash('sha256').update(x).digest('hex');
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};
const chain = (prev, seq, type, actor, body, at) => digest(stable({ prev, seq, type, actor, body, at }));
export class Store {
  constructor(file = ':memory:') { this.db = new DatabaseSync(file); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS events(item TEXT,seq INTEGER,type TEXT,actor TEXT,body_hash TEXT,prev_hash TEXT,hash TEXT,at TEXT,idem TEXT,PRIMARY KEY(item,seq),UNIQUE(item,idem)); CREATE TABLE IF NOT EXISTS bodies(hash TEXT PRIMARY KEY,bytes TEXT); CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS items(item TEXT PRIMARY KEY,state TEXT,head TEXT,seq INTEGER)'); }
  events(item) { return this.db.prepare('SELECT * FROM events WHERE item=? ORDER BY seq').all(item).map(r => ({ ...JSON.parse(this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(r.body_hash)?.bytes || '{}'), type: r.type, actor: r.actor, body_hash: r.body_hash, at: r.at })); }
  read(item) { return fold(this.events(item)); }
  append(item, event, { expectedSeq, idem } = {}) {
    if (!item || !event || !event.type || !event.actor || !idem) throw new Error('item, event, actor, idem required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT seq FROM events WHERE item=? AND idem=?').get(item, idem); if (old) { this.db.exec('COMMIT'); return { idempotent: true, seq: old.seq, ...this.read(item) }; }
      const cache = this.db.prepare('SELECT * FROM items WHERE item=?').get(item); const seq = (cache?.seq || 0) + 1;
      if (expectedSeq !== undefined && expectedSeq !== (cache?.seq || 0)) throw new Error('stale expectedSeq');
      if (typeof event.at !== 'string' || !event.at) throw new Error('event.at required');
      const body = { ...event }; delete body.type; delete body.actor; const bytes = stable(body); const body_hash = digest(bytes); const at = event.at; const prior = this.events(item); const r = step(fold(prior).context || initial(), { ...event, body_hash, at }); if (r.refusal) throw new Error(r.refusal);
      const prev_hash = cache?.head || ''; const hash = chain(prev_hash, seq, event.type, event.actor, body_hash, at);
      this.db.prepare('INSERT OR IGNORE INTO bodies VALUES(?,?)').run(body_hash, bytes); this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)').run(item, seq, event.type, event.actor, body_hash, prev_hash, hash, at, idem); this.db.prepare('INSERT OR IGNORE INTO people VALUES(?)').run(event.actor); this.db.prepare('INSERT INTO items VALUES(?,?,?,?) ON CONFLICT(item) DO UPDATE SET state=excluded.state,head=excluded.head,seq=excluded.seq').run(item, r.state, hash, seq); this.db.exec('COMMIT'); return { seq, hash, ...this.read(item), effects: r.effects };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  verify(item) { const rows = this.db.prepare('SELECT * FROM events WHERE item=? ORDER BY seq').all(item); const erased = new Set(rows.filter(r=>r.type==='erased').map(r=>this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(r.body_hash)?.bytes).filter(Boolean).map(x=>JSON.parse(x).body_hash)); let prev = '', seq = 0; for (const r of rows) { if (r.seq !== ++seq) return { ok: false, seq: r.seq, reason: 'sequence' }; const b = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(r.body_hash); if ((!b && !erased.has(r.body_hash)) || (b && digest(b.bytes) !== r.body_hash)) return { ok: false, seq: r.seq, reason: 'body' }; const h = chain(prev, r.seq, r.type, r.actor, r.body_hash, r.at); if (r.prev_hash !== prev || r.hash !== h) return { ok: false, seq: r.seq, reason: 'chain' }; prev = r.hash; } return { ok: true }; }
  rebuild() { this.db.exec('DELETE FROM items'); for (const { item } of this.db.prepare('SELECT DISTINCT item FROM events').all()) { const rows = this.db.prepare('SELECT * FROM events WHERE item=? ORDER BY seq').all(item); const f = this.read(item); const last = rows.at(-1); this.db.prepare('INSERT INTO items VALUES(?,?,?,?)').run(item, f.state, last?.hash || '', last?.seq || 0); } }
  erase(body_hash, actor = 'eraser') { const rows = this.db.prepare('SELECT item FROM events WHERE body_hash=?').all(body_hash); this.db.prepare('DELETE FROM bodies WHERE hash=?').run(body_hash); for (const { item } of rows) this.append(item, { type: 'erased', actor, role: 'member', body_hash, at: 'erased' }, { expectedSeq: this.db.prepare('SELECT seq FROM items WHERE item=?').get(item).seq, idem: `erase:${body_hash}:${item}` }); }
  exportJsonl() { return this.db.prepare('SELECT e.*,b.bytes FROM events e LEFT JOIN bodies b ON b.hash=e.body_hash ORDER BY item,seq').all().map(x => JSON.stringify(x)).join('\n') + '\n'; }
  importJsonl(text) { for (const line of text.trim().split('\n')) { const r = JSON.parse(line); if (!r.bytes || digest(r.bytes) !== r.body_hash || chain(r.prev_hash, r.seq, r.type, r.actor, r.body_hash, r.at) !== r.hash) throw new Error(`bad import ${r.seq}`); this.db.prepare('INSERT OR IGNORE INTO bodies VALUES(?,?)').run(r.body_hash, r.bytes); this.append(r.item, { ...JSON.parse(r.bytes), type: r.type, actor: r.actor, at: r.at }, { expectedSeq: r.seq - 1, idem: r.idem }); } }
  close() { this.db.close(); }
}
