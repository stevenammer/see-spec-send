import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { modelMessages } from '../intelligence/prompt.js';
import { runAnalysis } from '../intelligence/run.js';
import { verifyImpact } from '../reanalysis/verify.js';

// A live run showed a model echoing back prompts that describe their answer with placeholder values or that carry
// instruction text beside the data. These tests keep the fixed shape.
const at = '2026-11-16T12:00:00.000Z';

test('the reanalysis check tells the model exactly what to return and never shows type placeholders', async () => {
  let prompt;
  await verifyImpact({ delta: { body_hash: 'd', claims: [{ text: 'The export carries the caller note.' }] }, impact: { target: { item: 'old' }, cites: [{ quoted: 'Needs a new integration.' }], why_this_case: 'Recorded terms overlap.' },
    askModel: async p => { prompt = p; return JSON.stringify({ material: false, bears_on: [], known_unknowns: [], contrary: [] }); } });
  assert.match(prompt.instructions, /exactly these keys/);
  assert.deepEqual(prompt.new_result, ['The export carries the caller note.']); assert.deepEqual(prompt.old_statements, ['Needs a new integration.']);
  assert.ok(!/"boolean"|exact cite quotes only|up to five strings/.test(JSON.stringify(prompt)), 'no placeholder type names as values');
  const shown = modelMessages(JSON.stringify(prompt));
  assert.match(shown.system, /Reply with one JSON object and nothing else/);
  const user = JSON.parse(shown.user);
  assert.deepEqual(Object.keys(user).sort(), ['example_reply', 'new_result', 'old_statements', 'why_matched'], 'instruction text and audit fields are not sent beside the data');
  assert.equal(typeof user.example_reply.material, 'boolean');
});

test('the question lane puts rules in the system message and only data and the answer shape in the user message', async () => {
  const store = new Store(); store.registerPerson('alex');
  store.append('a1', { type: 'posted', actor: 'alex', rules: 3, original: 'Decision: we declined the integration for lack of budget.', at }, { idem: 'a1' });
  let packet;
  await runAnalysis({ store, viewer: 'alex', request: { question: 'Which decisions depend on an integration?', objectives: ['Understand conditions.'], constraints: ['Preserve privacy.'], items: ['a1'], from: at, to: '2026-11-16T13:00:00.000Z' }, now: at, askModel: async p => { packet = p; return 'not json'; } }).catch(() => {});
  assert.ok(packet?.answer_contract);
  const shown = modelMessages(JSON.stringify(packet));
  assert.ok(shown.system.includes(packet.instructions) && /exactly one JSON object/.test(shown.system));
  const user = JSON.parse(shown.user);
  assert.deepEqual(Object.keys(user).sort(), ['answer_contract', 'coverage', 'request', 'sources']);
  assert.ok(!shown.user.includes(packet.instructions.slice(0, 40)), 'the long instruction text is not repeated in the data message');
  store.close();
});

test('motive and personal-verdict questions are refused up front, before any model call', async () => {
  const store = new Store(); store.registerPerson('alex');
  store.append('a1', { type: 'posted', actor: 'alex', rules: 3, original: 'Decision: declined.', at }, { idem: 'a1' });
  for (const question of ['Why did the leader decline the integration, and what were their motives?', 'What motive did the manager have?', 'Why did the director block it?', 'Rank the agents.', 'Who are the weakest links?']) {
    let calls = 0;
    const result = await runAnalysis({ store, viewer: 'alex', request: { question, objectives: ['Understand conditions.'], constraints: ['Preserve privacy.'], items: ['a1'], from: at, to: '2026-11-16T13:00:00.000Z' }, now: at, askModel: async () => { calls += 1; return '{}'; } });
    assert.equal(calls, 0, question); assert.equal(result.receipt.reframed, true, question);
  }
  const ordinary = await runAnalysis({ store, viewer: 'alex', request: { question: 'Which documented decisions mention a budget?', objectives: ['Understand conditions.'], constraints: ['Preserve privacy.'], items: ['a1'], from: at, to: '2026-11-16T13:00:00.000Z' }, now: at });
  assert.equal(ordinary.receipt.reframed, false, 'an ordinary question is not refused');
  store.close();
});

import { completeAnswer, unfence } from '../intelligence/prompt.js';
test('one outer code fence is accepted, nothing else around the JSON is', () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('```\n{"a":1}\n```\n'), '{"a":1}');
  assert.equal(unfence('Here you go:\n```json\n{"a":1}\n```'), 'Here you go:\n```json\n{"a":1}\n```', 'prose around the fence is not stripped');
  assert.equal(unfence('{"a":1}'), '{"a":1}');
});

test('the human question, objectives and constraints are filled in from the request; the model keeps its own findings and they are still fully checked', async () => {
  const store = new Store(); store.registerPerson('alex');
  store.append('a1', { type: 'posted', actor: 'alex', rules: 3, original: 'Decision: declined for lack of budget.', at }, { idem: 'a1' });
  const request = { question: 'Which decisions mention a budget?', objectives: ['Understand conditions.'], constraints: ['Preserve privacy.'], items: ['a1'], from: at, to: '2026-11-16T13:00:00.000Z' };
  const reply = packet => ({ question: 'a paraphrase', objectives: ['something else'], constraints: [], coverage_notes: ['Only one record.'],
    findings: [{ claim: 'A decision cites budget.', status: 'documented', citations: [{ item: packet.sources[0].item, hash: packet.sources[0].hash }], alternatives: ['Other causes.'], uncertainty: ['One record.'], next_investigation: ['Ask the owner.'] }],
    tradeoffs: ['Small sample.'], missingness: ['Other teams.'], correction_path: 'Add context.' });
  const ok = await runAnalysis({ store, viewer: 'alex', request, now: at, askModel: async packet => `\`\`\`json\n${JSON.stringify(reply(packet))}\n\`\`\`` });
  assert.equal(ok.receipt.answer.question, request.question, 'the model cannot restate the question');
  assert.deepEqual(ok.receipt.answer.constraints, request.constraints, 'a constraint cannot be dropped');
  assert.equal(ok.receipt.model_configuration.mode, 'model');
  const refusedMode = async askModel => (await runAnalysis({ store, viewer: 'alex', request, now: at, askModel })).receipt;
  const invented = await refusedMode(async packet => { const r = reply(packet); r.findings[0].citations = [{ item: 'a1', hash: 'f'.repeat(64) }]; return JSON.stringify(r); });
  assert.equal(invented.model_configuration.mode, 'model_refused_sources_only', 'an invented citation is refused, and the person still gets the sources');
  assert.match(invented.label, /model's answer was refused/i); assert.ok(invented.answer.findings.every(f => /no finding is asserted/.test(f.claim)));
  assert.equal((await refusedMode(async packet => JSON.stringify({ ...reply(packet), extra: 1 }))).model_configuration.mode, 'model_refused_sources_only', 'an extra key is still refused');
  const hollow = await refusedMode(async packet => JSON.stringify(packet.answer_contract));
  assert.equal(hollow.model_configuration.mode, 'model_refused_sources_only', 'a reply that only repeats the template text says nothing and is refused');
  assert.match(hollow.label, /repeats the template/);
  await assert.rejects(() => runAnalysis({ store, viewer: 'alex', request, now: at, askModel: async packet => { const r = reply(packet); r.findings[0].claim = 'The least effective employees caused this.'; return JSON.stringify(r); } }), /ranking or motive/);
  assert.equal(completeAnswer({ request, answer_contract: {} }, 'not json'), 'not json');
  store.close();
});

test('a status that starts with an allowed word and a single string for a list are repaired; invented statuses and bad citations are not', async () => {
  const store = new Store(); store.registerPerson('alex');
  store.append('a1', { type: 'posted', actor: 'alex', rules: 3, original: 'Decision: declined for lack of budget.', at }, { idem: 'a1' });
  const request = { question: 'Which decisions mention a budget?', objectives: ['Understand conditions.'], constraints: ['Preserve privacy.'], items: ['a1'], from: at, to: '2026-11-16T13:00:00.000Z' };
  const reply = (packet, status, extra = {}) => JSON.stringify({ coverage_notes: 'Only one record.', findings: [{ claim: 'A decision cites budget.', status, citations: [{ item: 'a1', hash: packet.sources[0].hash }], alternatives: 'Other causes.', uncertainty: ['One record.'], next_investigation: 'Ask the owner.', ...extra }], tradeoffs: 'Small sample.', missingness: ['Other teams.'], correction_path: 'Add context.' });
  const run = status => runAnalysis({ store, viewer: 'alex', request, now: at, askModel: async packet => reply(packet, status) });
  const repaired = await run('documented event; its claims are not independently verified');
  assert.equal(repaired.receipt.model_configuration.mode, 'model');
  assert.equal(repaired.receipt.answer.findings[0].status, 'documented');
  assert.deepEqual(repaired.receipt.answer.findings[0].alternatives, ['Other causes.']);
  assert.equal((await run('verified by the manager')).receipt.model_configuration.mode, 'model_refused_sources_only', 'an invented status is not repaired');
  assert.equal((await run('Documented')).receipt.answer.findings[0].status, 'documented');
  store.close();
});

test('the reanalysis check accepts one outer code fence around its JSON, and still validates everything inside', async () => {
  const delta = { body_hash: 'd', claims: [{ text: 'The export carries the caller note.' }] };
  const impact = { target: { item: 'old' }, cites: [{ quoted: 'Needs a new integration.' }], why_this_case: 'Recorded terms overlap.' };
  const fenced = obj => async () => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
  const ok = await verifyImpact({ delta, impact, askModel: fenced({ material: false, bears_on: [], known_unknowns: ['x'], contrary: [] }) });
  assert.equal(ok.material, false);
  await assert.rejects(() => verifyImpact({ delta, impact, askModel: fenced({ material: true, bears_on: ['invented'], known_unknowns: [], contrary: [] }) }), /citation/);
  await assert.rejects(() => verifyImpact({ delta, impact, askModel: async () => 'Sure! ```json\n{"material":false,"bears_on":[],"known_unknowns":[],"contrary":[]}\n```' }), /JSON/);
});
