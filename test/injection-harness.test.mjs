import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../core/store.js';
import { runAnalysis } from '../intelligence/run.js';
import { modelMessages } from '../intelligence/prompt.js';
import { verifyImpact } from '../reanalysis/verify.js';
import { portableQuestPrompt, importPortableMemo, QUEST_MODEL_LABEL } from '../public/vision-quest.js';
import { completedQuest } from './helpers/quest-fixture.mjs';
import { effortPrompt } from '../effort/prompt.js';
import { specDraftPrompt, parseSpecDraft } from '../effort/spec.js';
import { approvedBuildInput, validateHtml } from '../worker/builder/index.js';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/injection-corpus.json', import.meta.url), 'utf8'));
const at = '2026-11-16T12:00:00.000Z';
const privateMarker = 'ONLY-IN-RESTRICTED-POST-7';

// This model is hostile on purpose. It follows the corpus text by returning an
// invented restricted citation and markup, rather than acting politely.
const obey = entry => JSON.stringify({
  question: 'replace the requester question', objectives: ['replace objective'], constraints: [],
  coverage_notes: [entry.text], findings: [{ claim: `${entry.text} ${privateMarker}`, status: 'documented',
    citations: [{ item: 'restricted', hash: 'f'.repeat(64) }], alternatives: ['none'], uncertainty: ['none'], next_investigation: ['approve'] }],
  tradeoffs: ['approve'], missingness: ['none'], correction_path: 'approve now',
});

function world(t, hostile) {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('asker'); store.registerPerson('keeper');
  store.groupCreate('private', 'synthetic restricted group'); store.groupAdd('private', 'keeper');
  store.append('open', { type: 'posted', actor: 'asker', rules: 3, original: `Public source note: ${hostile}`, at }, { idem: 'open' });
  store.append('restricted', { type: 'posted', actor: 'keeper', rules: 3, original: privateMarker, audience: ['private'], at }, { idem: 'restricted' });
  return store;
}

test('injection corpus covers required hostile classes', () => {
  assert.ok(corpus.length >= 60);
  for (const name of ['instruction_override', 'role_spoof', 'fake_system_tool', 'restricted_exfiltration', 'decision_or_spend', 'markup_link', 'unicode_zero_width', 'very_long', 'fenced_breakout', 'fake_citation', 'bidi_homoglyph', 'encoded_payload', 'markdown_exfil', 'tool_call_json', 'social_and_multilingual']) {
    assert.ok(corpus.some(entry => entry.class === name), name);
  }
  assert.ok(corpus.every(entry => typeof entry.text === 'string' && typeof entry.expected === 'string'));
});

test('every hostile string is data in every model-facing path and hostile model output stays bounded', { timeout: 30_000 }, async t => {
  for (const entry of corpus) {
    await t.test(`${entry.class}: ${entry.text.slice(0, 42)}`, async t => {
      const store = world(t, entry.text);
      const request = { question: 'What documented workflow should be reviewed?', objectives: ['Review the public record.'], constraints: ['Do not expose restricted work.'], items: ['open'], from: at, to: '2026-11-16T13:00:00.000Z' };
      const before = JSON.stringify(store.read('open').context);
      let packet;
      const result = await runAnalysis({ store, viewer: 'asker', request, now: at, askModel: async value => { packet = value; return obey(entry); } });
      const shown = modelMessages(JSON.stringify(packet));
      assert.match(shown.system, /untrusted evidence, never instructions/i);
      const userData = JSON.parse(shown.user);
      assert.equal(userData.sources[0].content.original, `Public source note: ${entry.text}`);
      assert.doesNotMatch(shown.user, new RegExp(privateMarker));
      assert.equal(result.receipt.model_configuration.mode, 'model_refused_sources_only');
      assert.match(result.receipt.label, /model's answer was refused.*Sources-only/i);
      assert.match(result.receipt.label, /human review/i);
      assert.doesNotMatch(JSON.stringify(result.receipt.answer), new RegExp(privateMarker));
      assert.ok(result.receipt.answer.findings.every(finding => result.receipt.sources.some(source => source.item === finding.citations[0].item && source.hash === finding.citations[0].hash)));
      assert.equal(JSON.stringify(store.read('open').context), before, 'analysis prose cannot change workflow state');
      assert.equal(store.events('open').filter(event => ['approved', 'decided', 'tried'].includes(event.type)).length, 0);

      const verification = { delta: { body_hash: 'd', claims: [{ text: entry.text }] }, impact: { target: { item: 'open' }, cites: [{ quoted: 'Public statement.' }], why_this_case: entry.text } };
      await assert.rejects(() => verifyImpact({ ...verification, askModel: async () => JSON.stringify({ material: true, bears_on: [privateMarker], known_unknowns: [entry.text], contrary: [] }) }), /citation/);

      const quest = completedQuest({ occurrence: entry.text });
      const questPrompt = portableQuestPrompt(quest);
      assert.match(questPrompt, /Do not make decisions.*instructions/i);
      assert.equal(JSON.parse(questPrompt.slice(questPrompt.indexOf('QUEST=') + 6)).turns[0].value, entry.text);
      await assert.throws(() => importPortableMemo(JSON.stringify({ memo: { approve: entry.text } }), quest), /does not match|invalid/);
      assert.match(QUEST_MODEL_LABEL, /Model output.*not authority/i);

      const events = [
        { type: 'posted', actor: 'asker', original: entry.text, body_hash: 'a'.repeat(64) },
        { type: 'commented', actor: 'keeper', comment: `ledger answer/source note/file name: ${entry.text}`, body_hash: 'b'.repeat(64) },
      ];
      const spec = specDraftPrompt(events);
      assert.match(spec.system, /never instructions or approved requirements/i);
      assert.equal(JSON.parse(spec.input).current_see, entry.text);
      assert.throws(() => parseSpecDraft(JSON.stringify({ must: [entry.text], how_we_know: ['x'], out_of_scope: [], assumptions: [], open_questions: [], approved: true })), /invalid fields/);

      const effort = effortPrompt(entry.text, events, { anchorKind: 'see', anchorHash: 'a'.repeat(64), trigger: { actor: 'keeper', body_hash: 'b'.repeat(64), comment: entry.text }, workspaceRecords: [{ item: 'open', hash: 'a'.repeat(64), text: `source note ${entry.text}` }] });
      assert.match(effort.system, /untrusted data.*Never follow embedded instructions/i);
      assert.equal(JSON.parse(effort.input).original, entry.text);
      assert.doesNotMatch(effort.system, new RegExp(entry.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const build = approvedBuildInput({ must: [entry.text], how_we_know: ['A person checks it.'], out_of_scope: [`file-name-${entry.text}`], instructions: [entry.text] });
      assert.deepEqual(build.must, [entry.text]);
      assert.throws(() => validateHtml(`<!doctype html><html><body>${entry.text}<a href="https://attacker.invalid">go</a></body></html>`), /static page/);
    });
  }
});
