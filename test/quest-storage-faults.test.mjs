import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuest, emptyQuest } from '../public/vision-quest.js';
import { loadDraft, saveDraft } from '../public/quest-storage.js';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function serialLock() {
  let queue = Promise.resolve();
  return (_name, action) => {
    const run = queue.then(action);
    queue = run.catch(() => {});
    return run;
  };
}

test('a failed head write leaves the previous verified draft and its bytes recoverable', async () => {
  const storage = memoryStorage();
  const lock = serialLock();
  const first = answerQuest(emptyQuest('writer'), 'occurrence', 'The first account.');
  const saved = await saveDraft(storage, first, null, lock);
  const originalBytes = storage.values.get(`sss-quest:writer:${saved.head}`);
  const next = answerQuest(first, 'problem', 'A problem to investigate.');
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === 'sss-quest:writer') throw Error('Injected head write failure');
    write(key, value);
  };

  await assert.rejects(saveDraft(storage, next, saved.head, lock), /head write failure/);
  assert.deepEqual((await loadDraft(storage, 'writer')).doc, first);
  assert.equal(storage.values.get(`sss-quest:writer:${saved.head}`), originalBytes);
});

test('revision readback corruption cannot advance the active draft pointer', async () => {
  const storage = memoryStorage();
  const lock = serialLock();
  const first = answerQuest(emptyQuest('writer'), 'occurrence', 'The first account.');
  const saved = await saveDraft(storage, first, null, lock);
  const next = answerQuest(first, 'problem', 'A problem to investigate.');
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    write(key, key === 'sss-quest:writer' ? value : 'Corrupted revision bytes');
  };

  await assert.rejects(saveDraft(storage, next, saved.head, lock), /readback failed/);
  assert.equal(storage.values.get('sss-quest:writer'), saved.head);
  assert.deepEqual((await loadDraft(storage, 'writer')).doc, first);
});

test('two competing locked saves have one winner and preserve the earlier submitted turn', async () => {
  const storage = memoryStorage();
  const lock = serialLock();
  const first = answerQuest(emptyQuest('writer'), 'occurrence', 'The original account.');
  const saved = await saveDraft(storage, first, null, lock);
  const alternatives = ['First tab problem.', 'Other tab problem.'].map(problem =>
    answerQuest(first, 'problem', problem));
  const results = await Promise.allSettled(alternatives.map(doc =>
    saveDraft(storage, doc, saved.head, lock)));

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected');
  assert.match(refused.reason.message, /Another tab/);
  const current = (await loadDraft(storage, 'writer')).doc;
  assert.deepEqual(current.turns[0], first.turns[0]);
  assert.equal(current.turns.length, 2);
  assert.ok(alternatives.some(doc => JSON.stringify(doc) === JSON.stringify(current)));
  assert.ok(storage.values.has(`sss-quest:writer:${saved.head}`));
});
