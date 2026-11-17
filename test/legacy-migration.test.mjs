import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store.js';
import { SCHEMA_VERSION } from '../core/migrations.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};

// Build the published schema and hashes directly, without using the new Store to seed it.
function legacyDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'sss-legacy-'));
  const file = join(directory, 'legacy.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE actors(id TEXT PRIMARY KEY,kind TEXT,leader INTEGER,item TEXT);
    CREATE TABLE events(item TEXT,seq INTEGER,type TEXT,actor TEXT,body_hash TEXT,
      prev_hash TEXT,hash TEXT,at TEXT,idem TEXT,submitted_hash TEXT,
      PRIMARY KEY(item,seq),UNIQUE(item,idem));
    CREATE TABLE bodies(hash TEXT PRIMARY KEY,bytes TEXT);
    CREATE TABLE items(item TEXT PRIMARY KEY,state TEXT,head TEXT,seq INTEGER,context TEXT);`);
  db.prepare('INSERT INTO actors VALUES(?,?,?,NULL)').run('author', 'person', 0);
  db.prepare('INSERT INTO actors VALUES(?,?,?,NULL)').run('leader', 'person', 1);
  let previous = '';
  let spec;
  const rows = [];
  const definitions = [
    ['checked', 'author', { problem: 'Synthetic legacy problem', looked: ['a setting'],
      found: [], verdict: 'build_needed' }],
    ['specced', 'author', { must: ['small try'], how_we_know: ['two people confirm'],
      out_of_scope: [] }],
    ['approved', 'leader', null],
  ];
  for (const [type, actor, definition] of definitions) {
    const seq = rows.length + 1;
    const body = definition || { spec_hash: spec, cap_usd: 1, quorum: 2 };
    const bytes = stable(body);
    const bodyHash = hash(`i\0${bytes}`);
    if (type === 'specced') spec = bodyHash;
    const at = `2026-11-09T00:00:0${seq}.000Z`;
    const idem = String(seq);
    const chain = hash(stable({ prev: previous, seq, type, actor, bodyHash, at }));
    const submitted = hash(stable({ idem, event: { ...body, type, actor, at } }));
    db.prepare('INSERT INTO bodies VALUES(?,?)').run(bodyHash, bytes);
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('i', seq, type, actor, bodyHash, previous, chain, at, idem, submitted);
    rows.push(chain);
    previous = chain;
  }
  const context = { phase: 'SENDING', steward: 'author', approver: 'leader', specHash: spec,
    capMicros: 1_000_000, quorum: 2, spentMicros: 0, approval: 1, artifact: null, helpers: [] };
  db.prepare('INSERT INTO items VALUES(?,?,?,?,?)')
    .run('i', 'SENDING', previous, 3, stable(context));
  db.close();
  return { file, rows, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('old database migration preserves hashes and rebuilds the changed context cache', () => {
  const fixture = legacyDatabase();
  let store;
  try {
    store = new Store(fixture.file);
    assert.deepEqual(store.eventRows('i').map(row => row.hash), fixture.rows);
    assert.equal(store.verify('i').ok, true);
    assert.deepEqual(store.verifyAll(), [{ item: 'i', ok: true }]);
  } finally {
    store?.db.close();
    fixture.close();
  }
});

test('legacy authority is captured once and survives demotion, reopen and a new event', () => {
  const fixture = legacyDatabase();
  let store;
  try {
    store = new Store(fixture.file);
    const before = store.read('i');
    store.registerPerson('leader', { leader: false });
    store.db.close();
    store = new Store(fixture.file);
    assert.deepEqual(store.read('i'), before);
    store.append('i', { type: 'commented', actor: 'author', at: '2026-11-10T00:00:00.000Z',
      comment: 'An independent later note.',
      ...(before.context.specHash ? { anchor_kind: 'spec', anchor_hash: before.context.specHash } : {}) }, { idem: 'later' });
    assert.equal(store.verify('i').ok, true);
    assert.deepEqual(store.verifyAll(), [{ item: 'i', ok: true }]);
  } finally {
    store?.db.close();
    fixture.close();
  }
});

test('upgrading an old database rewrites the stored context cache from the events', () => {
  const fixture = legacyDatabase();
  let store;
  try {
    const raw = new DatabaseSync(fixture.file);
    const legacy = JSON.parse(raw.prepare("SELECT context FROM items WHERE item='i'").get().context);
    raw.close();
    assert.equal(legacy.specAuthor, undefined, 'the fixture really is an old-shape cache');
    store = new Store(fixture.file);
    const stored = JSON.parse(store.db.prepare("SELECT context FROM items WHERE item='i'").get().context);
    assert.equal(stored.specAuthor, 'author', 'the cache was rebuilt, not just left as the old rows had it');
    assert.deepEqual(stored.ineligibleHelpers, ['author', 'leader']);
    // The step itself must refresh the cache, even though a later upgrade step would also do it.
    store.db.prepare("UPDATE items SET context=? WHERE item='i'").run(JSON.stringify(legacy));
    store.backfillAuthoritySnapshots();
    const refreshed = JSON.parse(store.db.prepare("SELECT context FROM items WHERE item='i'").get().context);
    assert.equal(refreshed.specAuthor, 'author', 'the backfill step rebuilds the derived cache by itself');
  } finally {
    store?.db.close();
    fixture.close();
  }
});

test('running the authority backfill again never overwrites the roles captured the first time', () => {
  const fixture = legacyDatabase();
  let store;
  try {
    store = new Store(fixture.file);
    const snapshot = () => store.db.prepare('SELECT seq,actor_kind,actor_leader,authority_version FROM events ORDER BY seq').all();
    const first = snapshot();
    assert.equal(first.at(-1).actor_leader, 1, 'the leader was a leader when the registry was first captured');
    store.registerPerson('leader', { leader: false });
    store.backfillAuthoritySnapshots();
    assert.deepEqual(snapshot(), first, 'a later backfill does not rewrite the roles it already captured');
  } finally {
    store?.db.close();
    fixture.close();
  }
});

test('the copy taken before an upgrade is owner-only, even under a permissive umask', () => {
  const fixture = legacyDatabase();
  let store;
  const previous = process.umask(0);
  try {
    store = new Store(fixture.file);
    const backup = `${fixture.file}.pre-v${SCHEMA_VERSION}.bak`;
    assert.equal((statSync(backup).mode & 0o777).toString(8), '600');
  } finally {
    process.umask(previous);
    store?.db.close();
    fixture.close();
  }
});

test('verifyAll finds an item that has events but no cache row, memory rows or lineage', () => {
  const fixture = legacyDatabase();
  let store;
  try {
    store = new Store(fixture.file);
    assert.deepEqual(store.verifyAll().map(row => row.item), ['i']);
    store.db.prepare("DELETE FROM items WHERE item='i'").run();
    for (const [table, column] of [['search_docs', 'item'], ['contributions', 'item'], ['lineage', 'child']]) {
      try { store.db.prepare(`DELETE FROM ${table} WHERE ${column}='i'`).run(); } catch { /* the table may not exist in this schema */ }
    }
    const found = store.verifyAll();
    assert.ok(found.some(row => row.item === 'i'), 'the orphaned events cannot hide from a full verification');
  } finally {
    store?.db.close();
    fixture.close();
  }
});
