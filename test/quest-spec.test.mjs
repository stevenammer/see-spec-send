import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, SQUIRREL_THRESHOLD, SQUIRREL_WEIGHTS, checkedFromQuest, compactQuest, deriveQuest,
  nextQuestion, playback, squirrel } from '../public/vision-quest.js';
import { questPage } from '../app/pages.js';
import { completedQuest } from './helpers/quest-fixture.mjs';

// One test per done-test in the Vision Quest spec that applies to the form with no model.
const verdicts = ['BUILD', 'CONFIGURE', 'BUY OR USE', 'PROCESS CHANGE', 'KILL'];
const scripts = {
  BUILD: {},
  CONFIGURE: { setting: 'works' },
  'BUY OR USE': { pay_for: 'works' },
  'PROCESS CHANGE': { approach: 'process' },
  KILL: { approach: 'stop' },
};

test('spec 1: a scripted answer set gives a memo with looked entries and one of the five verdicts', () => {
  for (const [expected, overrides] of Object.entries(scripts)) {
    const draft = deriveQuest(completedQuest(overrides));
    assert.equal(draft.recommendation, expected);
    assert.ok(verdicts.includes(draft.recommendation));
    assert.ok(draft.checked.looked.length > 0, expected);
    assert.ok(draft.memo.strongestReasonNot && draft.memo.stopCondition && draft.memo.risk);
    assert.ok(draft.memo.decisionOwner && draft.memo.informed && draft.memo.reversibility);
  }
});

test('spec 2: a just-a-bad-field script ends with CONFIGURE and no build', () => {
  const doc = completedQuest({ setting: 'works', problem: 'One field rejects a valid value' });
  const draft = deriveQuest(doc);
  assert.equal(draft.recommendation, 'CONFIGURE');
  assert.equal(draft.checked.verdict, 'setting');
  assert.notEqual(draft.checked.verdict, 'build_needed');
  assert.match(draft.reason, /no build is proposed/);
});

test('spec 4: a harassment script stops ordinary analysis and routes to a person', () => {
  const doc = completedQuest({ occurrence: 'A coworker was harassed by a manager' });
  assert.equal(nextQuestion(doc), null);
  const draft = deriveQuest(doc);
  assert.equal(draft.stopped, true);
  assert.match(draft.message, /authorized human/);
  assert.equal(draft.recommendation, undefined);
  assert.throws(() => checkedFromQuest(doc, 'maker'), /cannot be posted/);
});

test('spec 5: no praise openers and no em or en dashes in any text the session shows', () => {
  const doc = completedQuest();
  const shown = [JSON.stringify(STEPS), compactQuest(doc), playback(doc), JSON.stringify(deriveQuest(doc)),
    JSON.stringify(deriveQuest(completedQuest({ occurrence: 'a harassment report' }))), questPage('maker')];
  for (const file of ['public/vision-quest.js', 'public/quest-ui.js']) {
    shown.push(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  }
  for (const text of shown) {
    assert.doesNotMatch(text, /[–—]/);
    assert.doesNotMatch(text, /Absolutely|Great question|Certainly|Happy to help|You're absolutely right/i);
  }
});

test('spec 6: a scripted distraction scores below the threshold and says so', () => {
  const doc = completedQuest({ impact: '1', repeat: '1', control: '1', evidence: '1' });
  const signal = squirrel(doc);
  assert.ok(signal.score < signal.threshold);
  const draft = deriveQuest(doc);
  assert.equal(draft.recommendation, 'KILL');
  assert.match(draft.reason, /distraction/);
  assert.throws(() => checkedFromQuest(doc, 'maker'), /cannot be posted/);
});

test('squirrel weights are one named provisional default that sums to 100', () => {
  assert.deepEqual({ ...SQUIRREL_WEIGHTS }, { impact: 40, repeat: 30, control: 20, evidence: 10 });
  assert.equal(Object.values(SQUIRREL_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.equal(SQUIRREL_THRESHOLD, 60);
  assert.equal(squirrel(completedQuest()).score, 100);
  assert.equal(squirrel(completedQuest({ impact: '4', repeat: '0', control: '0', evidence: '0' })).score, 40);
  assert.throws(() => { SQUIRREL_WEIGHTS.impact = 1; }, TypeError);
});
