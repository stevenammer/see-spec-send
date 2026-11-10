import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store.js';

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
      comment: 'An independent later note.' }, { idem: 'later' });
    assert.equal(store.verify('i').ok, true);
    assert.deepEqual(store.verifyAll(), [{ item: 'i', ok: true }]);
  } finally {
    store?.db.close();
    fixture.close();
  }
});
