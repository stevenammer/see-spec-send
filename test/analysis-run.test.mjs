import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { challengeAnalysisReceipt, readAnalysisReceipt, runAnalysis } from '../intelligence/run.js';

const at = '2026-11-16T12:00:00.000Z';
const request = items => ({ question: 'Which documented handoff conditions should we investigate?', objectives: ['Improve handoff completeness.'], constraints: ['Preserve employee privacy.'], items, from: at, to: '2026-11-16T13:00:00.000Z' });
function setup(t) {
  const store = new Store(); t.after(() => store.close());
  for (const id of ['alex', 'blair', 'casey', 'leader']) store.registerPerson(id, { leader: id === 'leader' });
  store.groupCreate('Shared'); store.groupAdd('Shared', 'alex'); store.groupAdd('Shared', 'blair');
  store.append('open', { type: 'posted', actor: 'leader', rules: 2, original: 'Synthetic leader decision: keep the handoff checklist.', at }, { idem: 'open' });
  store.append('restricted', { type: 'posted', actor: 'casey', rules: 3, audience: ['Shared'], original: 'Synthetic restricted handoff record.', at }, { idem: 'restricted' });
  return store;
}

test("finding about a leader's decision is returned like any other; no rank filter", async t => {
  const store = setup(t);
  const result = await runAnalysis({ store, viewer: 'alex', request: request(['open']), now: at });
  assert.equal(result.receipt.answer.findings.length, 1);
  assert.equal(result.receipt.answer.findings[0].citations[0].item, 'open');
  assert.equal(result.receipt.model_configuration.mode, 'sources_only');
  assert.equal(result.receipt.sources[0].item, 'open');
});

test('weakest-links question is refused or reframed to criteria, outcomes and unknowns; no motives, no ranking', async t => {
  const store = setup(t);
  const result = await runAnalysis({ store, viewer: 'alex', request: { ...request(['open']), question: 'Who are the weakest links and why are they intentionally blocking us?' }, now: at });
  const text = JSON.stringify(result.receipt.answer);
  assert.equal(result.receipt.reframed, true);
  assert.match(result.receipt.answer.refusal, /criteria, outcomes, and unknowns/i);
  assert.doesNotMatch(text, /leader|alex|casey|blair/i);
  assert.equal(result.receipt.model_configuration.provider, 'none');
  await assert.rejects(() => runAnalysis({ store, viewer: 'alex', request: request(['open']), now: at, askModel: async packet => {
    const answer = structuredClone(packet.answer_contract); answer.findings[0].claim = 'The least effective employees caused this.'; return JSON.stringify(answer);
  } }), /ranking or motive/);
});

test('two people with the same scope get the same source set and receipt fields; prose may differ', async t => {
  const store = setup(t);
  const one = await runAnalysis({ store, viewer: 'alex', request: request(['open', 'restricted']), now: at });
  const two = await runAnalysis({ store, viewer: 'blair', request: request(['open', 'restricted']), now: '2026-11-16T12:01:00.000Z' });
  assert.equal(one.receipt.source_set_hash, two.receipt.source_set_hash);
  assert.deepEqual(one.receipt.sources, two.receipt.sources);
  assert.deepEqual(Object.keys(one.receipt).sort(), Object.keys(two.receipt).sort());
  assert.equal(readAnalysisReceipt(store, 'blair', one.receipt.hash).scope, 'same');
  const challenge = challengeAnalysisReceipt(store, 'blair', one.receipt.hash, 'Synthetic counterexample: a documented exception exists.', at);
  assert.equal(store.knowledge.entries('analysis_challenge')[0].hash, challenge.hash);
});

test('narrower scope: difference is disclosed, restricted sources absent', async t => {
  const store = setup(t);
  const result = await runAnalysis({ store, viewer: 'alex', request: request(['open', 'restricted']), now: at });
  const narrowed = readAnalysisReceipt(store, 'casey', result.receipt.hash);
  assert.deepEqual(narrowed, { scope: 'differs', message: 'Your current read scope differs. Restricted sources and the answer are not shown.' });
  assert.doesNotMatch(JSON.stringify(narrowed), /\bopen\b|[a-f0-9]{64}/i);
});

test('AI answer is never a KnowledgeDelta and never an annex source', async t => {
  const store = setup(t); let called = 0;
  const result = await runAnalysis({ store, viewer: 'alex', request: request(['open']), now: at, askModel: async packet => { called += 1; const answer = structuredClone(packet.answer_contract); const f = answer.findings[0]; f.claim = 'The open record documents a decision to keep the handoff checklist.'; f.alternatives = ['The checklist may be kept for another reason.']; f.uncertainty = ['Only one record was included.']; f.next_investigation = ['Ask the record owner what the checklist covers.']; answer.tradeoffs = ['One record is a small sample.']; answer.missingness = ['Other teams records are not included.']; return JSON.stringify(answer); } });
  assert.equal(called, 1); assert.equal(result.receipt.model_configuration.mode, 'model');
  assert.deepEqual(store.knowledge.entries().map(entry => entry.kind), ['analysis_receipt']);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type IN ('knowledge_delta','annex')").get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge_log WHERE kind IN (\'delta\',\'annex\')').get().n, 0);
});
