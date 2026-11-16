import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { runReanalysis } from '../reanalysis/run.js';
import { runAnalysis } from '../intelligence/run.js';
import { searchKnowledge } from '../knowledge/index.js';
import { runCloseoutJobs } from '../core/closeout.js';

const stamp = '2026-11-16T10:00:00.000Z', later = '2026-11-16T12:00:00.000Z';
const SECRET = 'zebra-seventy-seven-night-shift-badge-codes';
let n = 0;

// Everything that can copy source text: results, updates, saved question answers, the ledger, search, closing reports.
function world(t) {
  const s = new Store(); t.after(() => s.close());
  for (const id of ['dana', 'sam']) s.registerPerson(id); s.registerPerson('lee', { leader: true });
  const add = (item, event) => s.append(item, { ...event, at: stamp }, { idem: `ec-${++n}` });
  const bind = item => ({ post_id: s.read(item).context.activePost?.id, post_version: s.read(item).context.activePost?.version });
  add('dana', { type: 'posted', actor: 'dana', original: 'The handoff loses the caller note.', rules: 3 });
  add('dana', { type: 'specced', actor: 'dana', see_hash: s.read('dana').context.seeHash, must: ['Keep note'], how_we_know: ['It shows'], out_of_scope: [], assumptions: ['The handoff needs a new integration to carry the caller note.'], open_questions: [], ...bind('dana') });
  const spec = s.read('dana').context.specHash, packet = s.putArtifact('dana', JSON.stringify({ specHash: spec }));
  add('dana', { type: 'sent', actor: 'dana', spec_hash: spec, packet_hash: packet, ...bind('dana') });
  add('dana', { type: 'decided', actor: 'lee', disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration this quarter.', metadata: {}, spec_hash: spec, packet_hash: packet, ...bind('dana') });
  // The item whose spec will be erased: its wording is a recorded result (it has estimates) that bears on Dana's case.
  add('kim', { type: 'posted', actor: 'sam', original: 'Another handoff problem.', rules: 3 });
  add('kim', { type: 'specced', actor: 'sam', see_hash: s.read('kim').context.seeHash, must: [`The caller note handoff needs no new integration; ${SECRET}.`], how_we_know: ['It works'], out_of_scope: [], assumptions: [`Badge codes ${SECRET} are stable.`], open_questions: [], estimates: [{ dimension: 'people_time', low: 1, high: 2, unit: 'days', basis: [], unknowns: [], alternatives: [] }], ...bind('kim') });
  runReanalysis(s, { now: later });
  return s;
}
const everywhere = s => {
  const found = [];
  for (const { name } of s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const row of s.db.prepare(`SELECT * FROM "${name}"`).all()) if (JSON.stringify(row, (_k, v) => typeof v === 'bigint' ? String(v) : v).includes(SECRET)) found.push(name);
  }
  return [...new Set(found)].sort();
};

test('after an erase, the erased wording survives in no table at all, not in any export, and not in anything a person can read', async t => {
  const s = world(t); const spec = s.events('kim').find(e => e.type === 'specced');
  const before = everywhere(s); assert.ok(before.includes('knowledge_log'), `the fixture must spread the wording into derived records (found in: ${before.join(', ')})`);
  // A saved answer from the question lane that quotes the source, as a real model answer would.
  const answered = await runAnalysis({ store: s, viewer: 'dana', request: { question: 'Which assumptions are recorded?', objectives: ['Understand.'], constraints: ['Be fair.'], items: ['kim'], from: stamp, to: '2026-11-16T23:00:00.000Z' }, now: later,
    askModel: async packet => JSON.stringify({ coverage_notes: ['One record.'], findings: [{ claim: `Badge codes ${SECRET} are described as stable.`, status: 'documented', citations: [{ item: packet.sources[0].item, hash: packet.sources[0].hash }], alternatives: ['They may change.'], uncertainty: ['One record.'], next_investigation: ['Ask the owner.'] }], tradeoffs: ['Small sample.'], missingness: ['Other teams.'], correction_path: 'Add context.' }) });
  assert.equal(answered.receipt.model_configuration.mode, 'model');
  assert.ok(everywhere(s).includes('knowledge_log'));
  s.erase('kim', spec.body_hash, 'lee', later, { ground: 'privacy', note: 'Synthetic erasure' });
  const exported = s.exportJsonl();
  assert.ok(!exported.includes(SECRET), `the export still contains the erased wording`);
  const where = everywhere(s);
  assert.deepEqual(where, [], `the erased wording is still stored in: ${where.join(', ')}`);
  const visible = JSON.stringify([s.knowledge.entries(), searchKnowledge(s, 'dana', SECRET), searchKnowledge(s, 'dana', 'badge')]);
  assert.ok(!visible.includes(SECRET), 'and nothing a person can read shows it');
  assert.ok(s.knowledge.verify().ok); assert.ok(s.verifyAll().every(row => row.ok));
});
