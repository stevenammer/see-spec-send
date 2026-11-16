import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { challengeClaim, isChallenged } from '../knowledge/corrections.js';
import { findImpacts } from '../reanalysis/match.js';
import { searchKnowledge } from '../knowledge/index.js';

const at = '2026-11-16T12:00:00.000Z';
const setup = () => {
  const store = new Store(); store.registerPerson('maya');
  store.append('case', { type: 'posted', actor: 'maya', rules: 3, original: 'The handoff loses the caller note.', at }, { idem: 'post' });
  const context = store.read('case').context;
  store.append('case', { type: 'commented', actor: 'maya', kind: 'comment', comment: 'The caller note appears in the current export.', anchor_kind: 'see', anchor_hash: context.seeHash, post_id: context.activePost.id, post_version: context.activePost.version, at }, { idem: 'comment' });
  return store;
};

test('erased source redacts dependent delta, annex, digest entry and index row', () => {
  const store = setup();
  try {
    const source = store.events('case').at(-1).body_hash;
    const delta = store.knowledge.append('delta', { v: 1, source: { item: 'case', body_hash: source }, claims: [{ text: 'The current export has the note.' }] }, { at });
    const annex = store.knowledge.append('annex', { v: 1, parent: { item: 'case' }, delta: delta.hash, statement: 'Found by Effort (AI).' }, { at });
    store.db.prepare('INSERT INTO digest_entries(id,person,annex_hash,created_at,seen_at,pinged) VALUES(?,?,?,?,NULL,0)').run('digest', 'maya', annex.hash, at);
    assert.equal(searchKnowledge(store, 'maya', 'current export').length, 0, 'comments are not typed knowledge rows');
    store.erase('case', source, 'maya', at);
    assert.equal(store.knowledge.entries('delta')[0].erased, true);
    assert.equal(store.knowledge.entries('annex')[0].erased, true);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM digest_entries').get().n, 0);
    assert.ok(store.db.prepare('SELECT count(*) AS n FROM knowledge_dependencies WHERE source_body_hash=?').get(source).n >= 1);
    assert.equal(searchKnowledge(store, 'maya', 'current export').length, 0, 'erased source has no index row');
  } finally { store.close(); }
});

test('challenge is attributed, visible, and removes the claim from matcher support', () => {
  const store = setup();
  try {
    const source = store.events('case').at(-1).body_hash;
    const delta = store.knowledge.append('delta', { v: 1, source: { item: 'case', body_hash: source }, claims: [{ text: 'export caller note integration' }] }, { at });
    challengeClaim(store, { target: source, actor: 'maya', note: 'This describes an old export, not the current one.', at });
    const correction = store.knowledge.entries('correction')[0];
    assert.equal(correction.body.actor, 'maya'); assert.match(correction.body.note, /old export/);
    assert.equal(isChallenged(store, delta.hash, source), true);
    assert.deepEqual(findImpacts(store, { hash: delta.hash, source: { item: 'case', body_hash: source }, claims: [{ text: 'export caller note integration' }] }).checked, []);
  } finally { store.close(); }
});

test('correction never alters the source event or its hash', () => {
  const store = setup();
  try {
    const before = store.eventRows('case').map(row => row.hash);
    const source = store.events('case').at(-1).body_hash;
    challengeClaim(store, { target: source, actor: 'maya', note: 'More context belongs here.', at });
    assert.deepEqual(store.eventRows('case').map(row => row.hash), before);
    assert.equal(store.verify('case').ok, true);
  } finally { store.close(); }
});
