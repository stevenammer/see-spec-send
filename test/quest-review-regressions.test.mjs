import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedFromQuest, deriveQuest, safetyStop } from '../public/vision-quest.js';
import { completedQuest } from './helpers/quest-fixture.mjs';
import * as storage from '../public/quest-storage.js';

const disk = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) };
};
const lock = async (_name, action) => action();

test('a reported solution survives weak signal; explicit stop and high risk still lead', () => {
  const weak = { impact: '1', repeat: '2', control: '4', evidence: '4' };
  for (const [key, recommendation] of [['setting', 'CONFIGURE'], ['have', 'BUY OR USE'],
    ['pay_for', 'BUY OR USE'], ['free', 'BUY OR USE']]) {
    assert.equal(deriveQuest(completedQuest({ ...weak, [key]: 'works' })).recommendation, recommendation);
    for (const gate of [{ approach: 'stop' }, { risk: 'high' }]) {
      const result = deriveQuest(completedQuest({ ...weak, [key]: 'works', ...gate }));
      assert.equal(result.recommendation, 'KILL');
      assert.match(result.reason, /decision owner/);
    }
  }
});

test('obvious personal safety reports and invisible separators stop the keyword guide', () => {
  for (const text of ['self\u2060harm', 'racist comments from my boss', 'overdose', 'keeps touching me',
    'hostile workplace', 'she was assaulted', 'retaliation', 'suicidal', 'harrassment',
    'threatened to hurt me', 'abuse', 'har\u200bass\u200dment', 'bullying']) {
    const quest = completedQuest({ occurrence: text });
    assert.equal(safetyStop(quest), true, text);
    assert.equal(deriveQuest(quest).stopped, true, text);
    assert.throws(() => checkedFromQuest(quest, 'maker'), /cannot be posted/);
  }
  assert.equal(safetyStop(completedQuest({ occurrence: 'The medical records field is wrong in our CRM' })), false);
});

test('posted output contains only the derived memo and proposed spec, never turns or private challenges', () => {
  const quest = completedQuest({ chair: 'PRIVATE CHAIR SENTINEL', depends: 'PRIVATE DEPENDENCY SENTINEL',
    first_test: 'One small test' });
  const posted = checkedFromQuest(quest, 'maker');
  assert.equal(posted.quest, undefined);
  assert.equal(posted.questMemo.recommendation, 'BUILD');
  assert.equal(posted.questMemo.spec.must[0], 'One small test');
  assert.doesNotMatch(JSON.stringify(posted), /PRIVATE CHAIR|PRIVATE DEPENDENCY|"turns"/);
});

test('starting another quest retains durable stopped and completed history; stale restart is refused', async () => {
  const store = disk();
  for (const quest of [completedQuest({ occurrence: 'harassment' }), completedQuest()]) {
    const current = await storage.loadDraft(store, 'maker');
    const saved = await storage.restoreDraft(store, await storage.sealQuest(quest), 'maker', current.head, lock);
    const next = await storage.startAnotherQuest(store, 'maker', saved.head, lock);
    assert.equal(next.doc.turns.length, 0);
    assert.notEqual(next.head, saved.head);
    assert.deepEqual(await storage.loadRevision(store, 'maker', saved.head), quest);
    assert.ok(storage.questHistory(store, 'maker').includes(saved.head));
    await assert.rejects(storage.startAnotherQuest(store, 'maker', saved.head, lock), /Another tab/);
  }
});

test('a posted receipt survives reload and restart, and failed restart preserves the active draft', async () => {
  const store = disk();
  const saved = await storage.saveDraft(store, completedQuest(), null, lock);
  storage.markQuestPosted(store, 'maker', saved.head, 'item-123');
  assert.equal(storage.postedQuestItem(store, 'maker', saved.head), 'item-123');
  const write = store.setItem;
  store.setItem = (key, value) => { if (key === 'sss-quest:maker') throw Error('quota'); write(key, value); };
  await assert.rejects(storage.startAnotherQuest(store, 'maker', saved.head, lock), /quota/);
  assert.deepEqual(await storage.loadDraft(store, 'maker'), saved);
  store.setItem = write;
  const next = await storage.startAnotherQuest(store, 'maker', saved.head, lock);
  assert.equal(storage.postedQuestItem(store, 'maker', next.head), null);
  assert.equal(storage.postedQuestItem(store, 'maker', saved.head), 'item-123');
});
