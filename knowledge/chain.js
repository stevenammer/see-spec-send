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
const kinds = new Set(['delta', 'impact', 'receipt', 'annex', 'annex_response']);

export class KnowledgeLog {
  constructor(store) { this.store = store; }
  append(kind, body, { at } = {}) {
    if (!kinds.has(kind) || typeof at !== 'string' || !at) throw new Error('knowledge kind and timestamp required');
    const bytes = canonical(body), body_hash = sha(bytes);
    const duplicate = this.store.db.prepare('SELECT seq,hash FROM knowledge_log WHERE kind=? AND body_hash=?').get(kind, body_hash);
    if (duplicate) return { seq: duplicate.seq, hash: duplicate.hash, body_hash, duplicate: true };
    const previous = this.store.db.prepare('SELECT seq,hash FROM knowledge_log ORDER BY seq DESC LIMIT 1').get();
    const seq = (previous?.seq || 0) + 1, prev_hash = previous?.hash || '', hash = sha(`${prev_hash}${kind}${body_hash}`);
    this.store.db.prepare('INSERT INTO knowledge_log(seq,kind,body,body_hash,prev_hash,hash,at) VALUES(?,?,?,?,?,?,?)')
      .run(seq, kind, bytes, body_hash, prev_hash, hash, at);
    return { seq, hash, body_hash, duplicate: false };
  }
  entries(kind) {
    const rows = kind ? this.store.db.prepare('SELECT * FROM knowledge_log WHERE kind=? ORDER BY seq').all(kind)
      : this.store.db.prepare('SELECT * FROM knowledge_log ORDER BY seq').all();
    return rows.map(row => ({ ...row, body: JSON.parse(row.body) }));
  }
  verify() {
    let previous = '';
    for (const row of this.store.db.prepare('SELECT * FROM knowledge_log ORDER BY seq').all()) {
      if (sha(row.body) !== row.body_hash || row.prev_hash !== previous || sha(`${previous}${row.kind}${row.body_hash}`) !== row.hash)
        return { ok: false, reason: 'chain' };
      previous = row.hash;
    }
    return { ok: true };
  }
}

export { canonical };
