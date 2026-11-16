// Correcting derived memory never edits an event or either hash chain.
// A correction is an attributed log entry; a retraction/tombstone changes
// what readers receive while preserving the original audit record.
export function challengeClaim(store, { target, actor, note, at }) {
  if (!/^[a-f0-9]{64}$/.test(target || '') || typeof actor !== 'string' || !actor || typeof note !== 'string' || !note.trim() || note.length > 2000 || typeof at !== 'string' || !at)
    throw new Error('attributed correction requires target, actor, note, and timestamp');
  if (!store.knowledge.entries().some(row => row.hash === target) && !store.db.prepare('SELECT 1 FROM events WHERE body_hash=?').get(target)) throw new Error('unknown source or derived record');
  return store.knowledge.append('correction', { v: 1, target, actor, kind: 'challenge', note: note.trim() }, { at });
}

export function isChallenged(store, target, sourceBodyHash = null) {
  return store.knowledge.entries('correction').some(row => !row.erased && row.body.kind === 'challenge' && (row.body.target === target || row.body.target === sourceBodyHash));
}

export function propagateErasure(store, sourceBodyHash, { reason, at }) {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_dependencies'").get()) return { tombstoned: 0 };
  const queue = [sourceBodyHash], seen = new Set(queue), derived = new Set();
  while (queue.length) {
    const source = queue.shift();
    for (const row of store.db.prepare('SELECT derived_hash FROM knowledge_dependencies WHERE source_body_hash=?').all(source)) {
      if (derived.has(row.derived_hash)) continue;
      derived.add(row.derived_hash);
      // Hashes can themselves appear as provenance in later derived records.
      if (!seen.has(row.derived_hash)) { seen.add(row.derived_hash); queue.push(row.derived_hash); }
    }
  }
  for (const hash of derived) {
    store.db.prepare('INSERT OR IGNORE INTO knowledge_tombstones(target_hash,reason,source_body_hash,at) VALUES(?,?,?,?)').run(hash, reason, sourceBodyHash, at);
    store.knowledge.append('retraction', { v: 1, target: hash, source_body_hash: sourceBodyHash, reason }, { at });
    store.db.prepare('DELETE FROM digest_entries WHERE annex_hash=?').run(hash);
  }
  store.db.prepare('UPDATE knowledge_bodies SET erased=1 WHERE body_hash=?').run(sourceBodyHash);
  return { tombstoned: derived.size };
}
