import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, answerQuest, checkedFromQuest, compactQuest, deriveQuest, emptyQuest,
  nextQuestion, safetyStop, validateQuest } from '../public/vision-quest.js';
import { loadDraft, openQuest, restoreDraft, saveDraft, sealQuest, loadPending, savePending } from '../public/quest-storage.js';

import { completedQuest } from './helpers/quest-fixture.mjs';

const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) };
};
const lock = async (_name, action) => action();

test('one question at a time, playback gates recommendations and explicit checked creation', () => {
  const empty = emptyQuest('maker');
  assert.equal(nextQuestion(empty).key, 'occurrence');
  assert.throws(() => answerQuest(empty, 'problem', 'Skip ahead'), /current question/);
  assert.throws(() => deriveQuest(empty), /Finish and confirm/);
  assert.throws(() => checkedFromQuest(empty, 'maker'), /Finish and confirm/);
  const doc = completedQuest();
  assert.equal(deriveQuest(doc).recommendation, 'BUILD');
  assert.ok(checkedFromQuest(doc, 'maker').looked.length);
  assert.throws(() => checkedFromQuest(doc, 'someone-else'), /Invalid quest/);
  assert.deepEqual(deriveQuest(doc).memo.verified, []);
});

test('a bad-field check is CONFIGURE, without proposing or automatically posting a build', () => {
  const doc = completedQuest({ setting: 'works', problem: 'A bad field asks for a duplicate value' });
  const draft = deriveQuest(doc);
  assert.equal(draft.recommendation, 'CONFIGURE');
  assert.match(draft.reason, /no build is proposed/);
  assert.equal(checkedFromQuest(doc, 'maker').verdict, 'setting');
  assert.ok(!Object.hasOwn(draft, 'events'));
  const used = completedQuest({ free: 'works' });
  assert.equal(checkedFromQuest(used, 'maker').verdict, 'free');
});

test('low-signal distractions, high risk and unchecked build options do not become proposals', () => {
  for (const overrides of [{ impact: '0', repeat: '0', control: '0', evidence: '0' },
    { risk: 'high' }, { have: 'unchecked' }]) {
    const doc = completedQuest(overrides);
    assert.equal(deriveQuest(doc).recommendation, 'KILL');
    assert.throws(() => checkedFromQuest(doc, 'maker'), /cannot be posted/);
  }
  const low = deriveQuest(completedQuest({ impact: '0', repeat: '0', control: '0', evidence: '0' }));
  assert.equal(low.signal.score, 0);
  assert.match(low.reason, /distraction/);
  const process = completedQuest({ approach: 'process' });
  assert.equal(deriveQuest(process).recommendation, 'PROCESS CHANGE');
  assert.equal(checkedFromQuest(process, 'maker').verdict, 'setting');
});

test('corrections retain original turns and require playback again before recommendations', () => {
  const doc = completedQuest();
  const corrected = answerQuest(doc, 'problem', 'Corrected account');
  assert.equal(corrected.turns[1].value, doc.turns[1].value);
  assert.equal(nextQuestion(corrected).key, 'playback');
  assert.throws(() => deriveQuest(corrected), /Finish and confirm/);
  assert.throws(() => answerQuest(corrected, 'first_test', 'Skip playback'), /Confirm the playback/);
  const confirmed = answerQuest(corrected, 'playback', 'yes');
  assert.equal(deriveQuest(confirmed).checked.problem, 'Corrected account');
  assert.match(compactQuest(confirmed), /your account/);
});

test('safety stays stopped through correction, pending text, export and restore', async () => {
  for (const term of ['harassment', 'discrimination', 'discriminatory', 'medical', 'disciplinary']) {
    let doc = completedQuest({ occurrence: `A ${term} concern was reported` });
    assert.ok(safetyStop(doc));
    doc = answerQuest(doc, 'occurrence', 'An ordinary request');
    assert.ok(safetyStop(doc));
    assert.equal(nextQuestion(doc), null);
    assert.ok(deriveQuest(doc).stopped);
    assert.throws(() => checkedFromQuest(doc, 'maker'), /cannot be posted/);
    const restored = await openQuest(await sealQuest(doc), 'maker');
    assert.ok(safetyStop(restored));
  }
  const pending = { ...completedQuest(), pending: {
    step: 'problem', value: 'A medical concern', note: '',
  } };
  assert.ok(safetyStop(pending));
  assert.throws(() => checkedFromQuest(pending, 'maker'), /cannot be posted/);
});

test('strict bounded transcript validation rejects malformed, oversized and reordered imports', async () => {
  const doc = completedQuest();
  for (const mutation of [d => d.turns.push({ step: 'unknown', value: 'x', note: '' }),
    d => { d.turns[0].value = 'x'.repeat(2001); },
    d => { d.turns[0].role = 'leader'; },
    d => { d.turns.reverse(); }, d => { d.version = 2; }]) {
    const bad = structuredClone(doc);
    mutation(bad);
    assert.throws(() => validateQuest(bad));
  }
  let large = emptyQuest('maker');
  for (let i = 0; i < 120; i += 1) {
    const next = structuredClone(large);
    next.turns.push({ step: 'occurrence', value: 'x'.repeat(2000), note: '' });
    try { validateQuest(next); large = next; } catch { break; }
  }
  assert.ok(JSON.stringify(large).length < 120000);
  assert.throws(() => validateQuest({ ...large, pending: {
    step: 'occurrence', value: 'x'.repeat(2000), note: 'x'.repeat(2000),
  } }));
  const bytes = JSON.parse(await sealQuest(doc));
  bytes.data.turns[0].value = 'Tampered';
  await assert.rejects(openQuest(JSON.stringify(bytes), 'maker'), /integrity/);
});

test('save-first immutable revisions survive failed writes and stale tab conflict', async () => {
  const store = storage();
  const doc = answerQuest(emptyQuest('maker'), 'occurrence', 'A real example');
  const first = await saveDraft(store, doc, null, lock);
  assert.deepEqual((await loadDraft(store, 'maker')).doc, doc);
  const previous = new Map(store.values);
  const more = answerQuest(doc, 'problem', 'A bounded problem');
  await assert.rejects(saveDraft(store, more, null, lock), /Another tab/);
  assert.deepEqual(store.values, previous);
  const originalSet = store.setItem;
  store.setItem = () => { throw Error('Quota exceeded'); };
  await assert.rejects(saveDraft(store, more, first.head, lock), /Quota/);
  assert.deepEqual(store.values, previous);
  store.setItem = originalSet;
  const second = await saveDraft(store, more, first.head, lock);
  assert.ok(store.values.has(`sss-quest:maker:${first.head}`));
  await assert.rejects(saveDraft(store, doc, second.head, lock), /original turns/);
  await assert.rejects(saveDraft(store, more, second.head, null), /unavailable/);
});

test('restore validates the whole file and identity before writes, and preserves transcript', async () => {
  const store = storage();
  const doc = completedQuest();
  const bytes = await sealQuest(doc);
  const state = await restoreDraft(store, bytes, 'maker', null, lock);
  assert.deepEqual(state.doc, doc);
  const previous = new Map(store.values);
  await assert.rejects(restoreDraft(store, bytes, 'other', null, lock), /Invalid quest/);
  await assert.rejects(restoreDraft(store, bytes.slice(0, -3), 'maker', state.head, lock));
  assert.deepEqual(store.values, previous);
});

test('new guide copy has no praise opener or dash punctuation', () => {
  const output = JSON.stringify(STEPS) + compactQuest(emptyQuest('maker'));
  assert.doesNotMatch(output, /[\u2013\u2014]/);
  assert.doesNotMatch(output, /Absolutely|Great question|Certainly/);
});


test('thousands of keystrokes use one bounded synchronous recovery slot, not revisions', () => {
  const store = storage();
  for (let i = 0; i < 3000; i += 1) {
    savePending(store, 'maker', 'tab-one', null, {
      step: 'occurrence', value: 'x'.repeat((i % 2000) + 1), note: '',
    });
  }
  assert.equal(store.values.size, 1);
  assert.ok([...store.values.values()][0].length < 5000);
  const pending = loadPending(store, 'maker', 'tab-one', null);
  assert.equal(pending.value.length, 1000);
  assert.equal(loadPending(store, 'maker', 'other-tab', null), null);
  assert.equal(loadPending(store, 'other', 'tab-one', null), null);
  assert.throws(() => loadPending(store, 'maker', 'tab-one', 'a'.repeat(64)), /older draft/);
});

test('explicit verified restore recovers corrupt pointers and missing revisions without deleting evidence', async () => {
  for (const broken of ['not-a-hash', 'b'.repeat(64)]) {
    const store = storage();
    store.setItem('sss-quest:maker', broken);
    const bytes = await sealQuest(completedQuest());
    await assert.rejects(restoreDraft(store, bytes, 'maker', 'stale', lock), /Another tab/);
    assert.equal(store.values.size, 1);
    const restored = await restoreDraft(store, bytes, 'maker', broken, lock);
    assert.ok(restored.head);
    assert.ok([...store.values.keys()].some(key => key.includes(':recovery:')));
    assert.ok([...store.values.values()].includes(broken));
    assert.deepEqual((await loadDraft(store, 'maker')).doc, completedQuest());
  }
});

test('unsent corrections cannot be posted as old accepted claims', () => {
  const doc = { ...completedQuest(), pending: {
    step: 'problem', value: 'An unsent corrected problem', note: '',
  } };
  assert.throws(() => checkedFromQuest(doc, 'maker'), /unsent correction/);
  const corrected = answerQuest(doc, 'problem', doc.pending.value);
  assert.throws(() => checkedFromQuest(corrected, 'maker'), /Finish and confirm/);
  const confirmed = answerQuest(corrected, 'playback', 'yes');
  assert.equal(checkedFromQuest(confirmed, 'maker').problem, 'An unsent corrected problem');
});


test('Unicode drafts use byte limits and every accepted export can be restored', async () => {
  let doc = completedQuest({ problem: '重'.repeat(1500), occurrence: '🙂'.repeat(750) });
  const bytes = await sealQuest(doc);
  assert.ok(new TextEncoder().encode(bytes).byteLength < 125000);
  assert.deepEqual(await openQuest(bytes, 'maker'), doc);
  let refused = false;
  for (let i = 0; i < 100; i += 1) {
    try { doc = answerQuest(doc, 'occurrence', '重'.repeat(2000)); }
    catch { refused = true; break; }
  }
  assert.ok(refused);
  assert.ok(new TextEncoder().encode(JSON.stringify(doc)).byteLength <= 120000);
  assert.deepEqual(await openQuest(await sealQuest(doc), 'maker'), doc);
});


test('escaped legal unsent input roundtrips under the same writer and reader byte bound', () => {
  const store = storage();
  const pending = { step: 'occurrence', value: '\u0001'.repeat(2000),
    note: '\n'.repeat(2000) };
  savePending(store, 'maker', 'tab', null, pending);
  assert.deepEqual(loadPending(store, 'maker', 'tab', null), pending);
});

test('stale per-tab recovery stays separate from the newer verified submitted journal', async () => {
  const store = storage();
  const first = await saveDraft(store,
    answerQuest(emptyQuest('maker'), 'occurrence', 'First example'), null, lock);
  savePending(store, 'maker', 'tab-a', first.head,
    { step: 'problem', value: 'Older unsent problem', note: '' });
  const newer = await saveDraft(store,
    answerQuest(first.doc, 'problem', 'Newer submitted problem'), first.head, lock);
  const current = await loadDraft(store, 'maker');
  assert.deepEqual(current, newer);
  let recovery;
  try { loadPending(store, 'maker', 'tab-a', newer.head); }
  catch (err) { recovery = err.recovery; }
  assert.equal(recovery.pending.value, 'Older unsent problem');
  const { loadRevision } = await import('../public/quest-storage.js');
  const old = await loadRevision(store, 'maker', recovery.head);
  const exported = await sealQuest({ ...old, pending: recovery.pending });
  assert.equal((await openQuest(exported, 'maker')).pending.value, 'Older unsent problem');
  assert.deepEqual(await loadDraft(store, 'maker'), newer);
});

test('archived stale pending survives subsequent input until explicit discard', async () => {
  const store = storage();
  store.removeItem = key => store.values.delete(key);
  const { archivePending, loadArchivedPending, discardArchivedPending } =
    await import('../public/quest-storage.js');
  const recovery = { version: 1, person: 'maker', head: null,
    pending: { step: 'occurrence', value: 'Older original input', note: '' } };
  archivePending(store, 'maker', 'tab', recovery);
  savePending(store, 'maker', 'tab', 'b'.repeat(64), {
    step: 'problem', value: 'Newer typing', note: '',
  });
  assert.deepEqual(loadArchivedPending(store, 'maker', 'tab'), recovery);
  assert.throws(() => archivePending(store, 'maker', 'tab', {
    ...recovery, pending: { ...recovery.pending, value: 'A different older input' },
  }), /earlier recovery/);
  assert.deepEqual(loadArchivedPending(store, 'maker', 'tab'), recovery);
  discardArchivedPending(store, 'maker', 'tab');
  assert.equal(loadArchivedPending(store, 'maker', 'tab'), null);
});
