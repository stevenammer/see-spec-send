import { createHash } from 'node:crypto';

const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(value => canonical(value) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().flatMap(key => {
    const encoded = canonical(value[key]);
    return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
  }).join(',')}}`;
};
const sha = value => createHash('sha256').update(value).digest('hex');
const kinds = new Set(['delta', 'impact', 'receipt', 'analysis_receipt', 'analysis_challenge', 'annex', 'annex_response', 'edge', 'capability', 'correction', 'retraction']);

export class KnowledgeLog {
  constructor(store) { this.store = store; }
  append(kind, body, { at } = {}) {
    if (!kinds.has(kind) || typeof at !== 'string' || !at) throw new Error('knowledge kind and timestamp required');
    const bytes = canonical(body), body_hash = sha(bytes);
    const duplicate = this.store.db.prepare('SELECT seq,hash FROM knowledge_log WHERE kind=? AND body_hash=?').get(kind, body_hash);
    if (duplicate) return { seq: duplicate.seq, hash: duplicate.hash, body_hash, duplicate: true };
    const previous = this.store.db.prepare('SELECT seq,hash FROM knowledge_log ORDER BY seq DESC LIMIT 1').get();
    const seq = (previous?.seq || 0) + 1, prev_hash = previous?.hash || '', hash = sha(`${prev_hash}${kind}${body_hash}`);
    this.store.db.prepare('INSERT OR IGNORE INTO knowledge_bodies(body_hash,bytes) VALUES(?,?)').run(body_hash, bytes);
    this.store.db.prepare('INSERT INTO knowledge_log(seq,kind,body,body_hash,prev_hash,hash,at) VALUES(?,?,?,?,?,?,?)')
      .run(seq, kind, bytes, body_hash, prev_hash, hash, at);
    if (this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_bodies'").get()) {
      this.store.db.prepare('INSERT OR IGNORE INTO knowledge_bodies(body_hash,bytes) VALUES(?,?)').run(body_hash, bytes);
      for (const source of sourceHashes(body)) {
        const sourceBody = this.store.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(source);
        if (sourceBody) this.store.db.prepare('INSERT OR IGNORE INTO knowledge_bodies(body_hash,bytes) VALUES(?,?)').run(source, sourceBody.bytes);
        this.store.db.prepare('INSERT OR IGNORE INTO knowledge_dependencies(source_body_hash,derived_hash,kind) VALUES(?,?,?)').run(source, hash, kind);
      }
    }
    return { seq, hash, body_hash, duplicate: false };
  }
  entries(kind) {
    // One query: erasure state comes from joins, not two lookups per row (this is read on hot paths).
    const sql = `SELECT l.*, (t.target_hash IS NOT NULL OR COALESCE(k.erased, 0) = 1) AS gone FROM knowledge_log l
      LEFT JOIN knowledge_tombstones t ON t.target_hash = l.hash LEFT JOIN knowledge_bodies k ON k.body_hash = l.body_hash`;
    const rows = kind ? this.store.db.prepare(`${sql} WHERE l.kind=? ORDER BY l.seq`).all(kind) : this.store.db.prepare(`${sql} ORDER BY l.seq`).all();
    return rows.map(({ gone, ...row }) => ({ ...row, body: gone ? { notice: 'This derived record was retracted or redacted because a source was erased.' } : JSON.parse(row.body), erased: Boolean(gone) }));
  }
  verify() {
    let previous = '';
    for (const row of this.store.db.prepare(`SELECT l.*,COALESCE(k.bytes,l.body) AS content, (t.target_hash IS NOT NULL OR COALESCE(k.erased,0)=1) AS gone
        FROM knowledge_log l LEFT JOIN knowledge_bodies k ON k.body_hash=l.body_hash LEFT JOIN knowledge_tombstones t ON t.target_hash=l.hash ORDER BY l.seq`).all()) {
      // The links between records are always checked. The text of an erased record is not: it may have been removed
      // from this copy (an import carries only its hashes), and an erased record must not need its text to verify.
      const bodyOk = row.gone ? true : sha(row.body) === row.body_hash && sha(row.content) === row.body_hash;
      if (!bodyOk || row.prev_hash !== previous || sha(`${previous}${row.kind}${row.body_hash}`) !== row.hash)
        return { ok: false, reason: 'chain' };
      previous = row.hash;
    }
    return { ok: true };
  }
}

// Only recorded source event body hashes become dependencies. Model text and
// free-form claim strings are deliberately never treated as sources.
function sourceHashes(body) {
  const found = new Set();
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(entry => visit(entry));
    for (const [name, entry] of Object.entries(value)) {
      if ((name === 'body_hash' || name === 'source_body_hash' || name === 'delta' || name === 'impact' || name === 'annex') && typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry)) found.add(entry);
      if (name === 'source' && entry && typeof entry === 'object' && typeof entry.body_hash === 'string') found.add(entry.body_hash);
      visit(entry, name);
    }
  };
  visit(body); return found;
}

export { canonical };
