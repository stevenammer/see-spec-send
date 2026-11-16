// Derived workspace memory. The event chains remain the source of truth.
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const words = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(entry => typeof entry === 'string').join('\n') : '';
const textOf = event => ['original', 'problem', 'text', 'comment', 'must', 'how_we_know', 'out_of_scope', 'assumptions', 'open_questions', 'reason', 'note', 'instruction']
  .map(key => words(event[key])).filter(Boolean).join('\n');
const hasMemory = store => !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_docs'").get();

export function initializeMemory(store) {
  try {
    store.db.exec(`CREATE VIRTUAL TABLE search_docs USING fts5(item UNINDEXED,seq UNINDEXED,kind UNINDEXED,author UNINDEXED,hash UNINDEXED,text);
      CREATE TABLE contributions(item TEXT NOT NULL, seq INTEGER NOT NULL, person TEXT NOT NULL, action TEXT NOT NULL,
        ref_hash TEXT NOT NULL, source_item TEXT NOT NULL, ai INTEGER NOT NULL, erased INTEGER NOT NULL,
        PRIMARY KEY(item,seq,person,action,ref_hash));
      CREATE INDEX contributions_person ON contributions(person,item,seq);
      CREATE TABLE research_config(source TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
      INSERT INTO research_config VALUES('this_workspace',0);`);
  } catch (error) {
    throw new Error(`workspace memory requires SQLite FTS5: ${error.message}`);
  }
  rebuildMemory(store);
}

function records(store, item) {
  const events = store.events(item);
  const erased = new Set(store.db.prepare(`SELECT json_extract(b.bytes,'$.body_hash') AS target
    FROM events e JOIN bodies b ON b.hash=e.body_hash WHERE e.item=? AND e.type='erased'`).all(item).map(row => row.target));
  const docs = [], contributions = [], unique = new Set();
  const add = (event, person, action, ref_hash, source_item = item, gone = false) => {
    const actor = store.db.prepare('SELECT kind FROM actors WHERE id=?').get(person);
    if (!actor || !['person', 'agent'].includes(actor.kind)) return;
    const seq = events.indexOf(event) + 1;
    const key = canonical([seq, person, action, ref_hash]);
    if (unique.has(key)) return;
    unique.add(key);
    contributions.push({ item, seq, person, action, ref_hash, source_item, ai: actor.kind === 'agent' ? 1 : 0, erased: gone ? 1 : 0 });
  };
  for (const [index, event] of events.entries()) {
    const seq = index + 1, gone = erased.has(event.body_hash);
    const text = textOf(event);
    if (!gone && text && event.type !== 'erased') docs.push({ item, seq, kind: event.type, author: event.actor, hash: event.body_hash, text });
    add(event, event.actor, 'authored', event.body_hash, item, gone);
    if (gone) continue;
    for (const credit of event.credits || []) {
      const source = events.find(entry => entry.body_hash === credit.comment);
      if (source && !erased.has(source.body_hash)) add(event, source.actor, 'included', source.body_hash);
    }
    if (event.type === 'steered' && event.source) {
      const source = events.find(entry => entry.body_hash === event.source);
      if (source && !erased.has(source.body_hash)) add(event, source.actor, 'adopted', source.body_hash);
    }
    if (event.type === 'credit_note') {
      const source = events.find(entry => entry.body_hash === event.source);
      if (source && !erased.has(source.body_hash)) add(event, event.person, 'credited', source.body_hash);
    }
    if (event.type === 'forked') {
      const source = store.events(event.parent.item)[event.parent.seq - 1];
      if (source) add(event, source.actor, 'fork_source', source.body_hash, event.parent.item);
    }
  }
  return { docs, contributions };
}

export function syncMemory(store, item) {
  if (!hasMemory(store)) return;
  const data = records(store, item);
  store.db.prepare('DELETE FROM search_docs WHERE item=?').run(item);
  store.db.prepare('DELETE FROM contributions WHERE item=?').run(item);
  const doc = store.db.prepare('INSERT INTO search_docs(item,seq,kind,author,hash,text) VALUES(?,?,?,?,?,?)');
  const credit = store.db.prepare('INSERT INTO contributions VALUES(?,?,?,?,?,?,?,?)');
  for (const row of data.docs) doc.run(row.item, row.seq, row.kind, row.author, row.hash, row.text);
  for (const row of data.contributions) credit.run(row.item, row.seq, row.person, row.action, row.ref_hash, row.source_item, row.ai, row.erased);
}

export function rebuildMemory(store) {
  if (!hasMemory(store)) return;
  store.db.exec('DELETE FROM search_docs; DELETE FROM contributions');
  for (const { item } of store.db.prepare('SELECT DISTINCT item FROM events').all()) syncMemory(store, item);
}

export function verifyMemory(store, item) {
  const expected = records(store, item);
  const docs = store.db.prepare('SELECT item,seq,kind,author,hash,text FROM search_docs WHERE item=?').all(item);
  const contributions = store.db.prepare('SELECT * FROM contributions WHERE item=?').all(item);
  const ordered = rows => rows.map(canonical).sort();
  return canonical(ordered(docs)) === canonical(ordered(expected.docs))
    && canonical(ordered(contributions)) === canonical(ordered(expected.contributions));
}

// The viewer predicate is deliberately part of each SQL read. There is no per-item
// audience partition in this product: all enabled workspace people can read posts.
export function searchMemory(store, person, text, { limit = 20 } = {}) {
  if (typeof person !== 'string' || typeof text !== 'string' || text.length > 500) return [];
  const tokens = text.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) || [];
  if (!tokens.length) return [];
  const query = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ');
  const size = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 20;
  return store.db.prepare(`SELECT d.item,d.seq,d.kind,d.author,d.text,d.hash FROM search_docs d
    JOIN actors viewer ON viewer.id=? AND viewer.kind='person'
    LEFT JOIN person_state ps ON ps.id=viewer.id
    JOIN events e ON e.item=d.item AND e.seq=d.seq AND e.body_hash=d.hash
    JOIN bodies b ON b.hash=e.body_hash AND b.erased=0
    WHERE search_docs MATCH ? AND COALESCE(ps.disabled,0)=0
      AND NOT EXISTS(SELECT 1 FROM events er JOIN bodies eb ON eb.hash=er.body_hash
        WHERE er.item=e.item AND er.type='erased' AND json_extract(eb.bytes,'$.body_hash')=e.body_hash)
    AND (NOT EXISTS(SELECT 1 FROM events first JOIN bodies fb ON fb.hash=first.body_hash
      WHERE first.item=d.item AND first.seq=1 AND json_array_length(json_extract(fb.bytes,'$.audience')) > 0)
      OR EXISTS(SELECT 1 FROM events first JOIN bodies fb ON fb.hash=first.body_hash JOIN group_members gm ON gm.person=viewer.id
        WHERE first.item=d.item AND first.seq=1 AND gm.group_name IN (SELECT value FROM json_each(json_extract(fb.bytes,'$.audience')))))
    ORDER BY e.at DESC,d.item,d.seq LIMIT ?`).all(person, query, size);
}

export function contributionMemory(store, viewer, subject) {
  if (typeof viewer !== 'string' || typeof subject !== 'string') return [];
  return store.db.prepare(`SELECT c.item,c.seq,e.type AS kind,e.actor AS author,e.body_hash AS hash,
    c.person,c.action,c.ref_hash,c.source_item,c.ai,c.erased
    FROM contributions c JOIN actors viewer ON viewer.id=? AND viewer.kind='person'
    LEFT JOIN person_state ps ON ps.id=viewer.id
    JOIN events e ON e.item=c.item AND e.seq=c.seq
    WHERE c.person=? AND COALESCE(ps.disabled,0)=0 ORDER BY e.at,c.item,c.seq,c.action`).all(viewer, subject);
}
