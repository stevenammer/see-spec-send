import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { readFileSync, readdirSync } from 'node:fs';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { AnalysisGateway } from '../gateway/analysis.js';
import { runReanalysis } from '../reanalysis/run.js';
import { verifyImpact } from '../reanalysis/verify.js';

const stamp = '2026-11-10T12:00:00.000Z', later = '2026-11-16T12:00:00.000Z'; let n = 0;
function world(t) {
  const store = new Store(); t.after(() => store.close()); for (const id of ['dana', 'sam', 'lee']) store.registerPerson(id, { leader: id === 'lee' });
  const add = (item, event) => store.append(item, { ...event, at: stamp }, { idem: `mv-${++n}` });
  const bind = item => ({ post_id: store.read(item).context.activePost.id, post_version: store.read(item).context.activePost.version });
  const item = (id, author, original, assumption) => { add(id, { type: 'posted', actor: author, original, rules: 3 }); add(id, { type: 'specced', actor: author, see_hash: store.read(id).context.seeHash, must: ['Keep note'], how_we_know: ['note exists'], out_of_scope: [], assumptions: [assumption], open_questions: [], ...bind(id) }); const spec = store.read(id).context.specHash, packet = store.putArtifact(id, JSON.stringify({ specHash: spec })); add(id, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(id) }); return { spec, packet }; };
  const dana = item('dana', 'dana', 'Caller note handoff fails.', 'A new integration carries the caller note.'); add('dana', { type: 'decided', actor: 'lee', disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration.', metadata: {}, spec_hash: dana.spec, packet_hash: dana.packet, ...bind('dana') });
  const sam = item('sam', 'sam', 'Export handoff fails.', 'Export permission is the blocker.'); add('sam', { type: 'decided', actor: 'lee', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'Existing export carries the caller note across handoff, so no integration is needed.', metadata: { alternative: 'Use export.', action_owner: 'sam' }, spec_hash: sam.spec, packet_hash: sam.packet, ...bind('sam') });
  return store;
}

test('advisory output can only downgrade, annotate exact citations, and records a metered receipt', async t => {
  const store = world(t); const ledger = new Ledger(store, { clock: () => Date.parse(later) }); ledger.configure(fixturePolicy()); let calls = 0;
  const gateway = new AnalysisGateway(ledger, async input => { calls += 1; const cite = JSON.parse(input.input).old_statements[0]; return { output: JSON.stringify({ material: true, bears_on: [cite], known_unknowns: ['Synthetic uncertainty.'], contrary: ['Synthetic contrary case.'] }), usage: { input_tokens: 2, output_tokens: 2 } }; }, { clock: () => Date.parse(later) });
  const out = await runReanalysis(store, { now: later, verify: (prompt, context) => gateway.ask(context.person, context.idem, prompt) });
  assert.equal(calls, 1); assert.equal(out.annexes.length, 1); const annex = store.knowledge.entries('annex')[0].body;
  assert.deepEqual(annex.known_unknowns, ['Synthetic uncertainty.']); assert.deepEqual(annex.contrary, ['Synthetic contrary case.']); assert.equal(gateway.receipts().length, 1);
  const held = world(t); const down = await runReanalysis(held, { now: later, verify: async () => JSON.stringify({ material: false, bears_on: [], known_unknowns: [], contrary: [] }) });
  assert.equal(down.annexes.length, 0); assert.ok(down.held.length > 0, 'model may hold but cannot upgrade');
});

test('invalid JSON, hostile paraphrase, timeout, and non-member citations leave deterministic result alone', async t => {
  for (const answer of ['not json', JSON.stringify({ material: true, bears_on: ['invented quote'], known_unknowns: [], contrary: [] }), 'Who are the weakest links?']) {
    const store = world(t); const out = await runReanalysis(store, { now: later, verify: async () => answer }); assert.equal(out.annexes.length, 1); assert.equal(store.knowledge.entries('annex')[0].body.known_unknowns, undefined);
  }
  const store = world(t); const out = await runReanalysis(store, { now: later, verify: async () => { throw Error('timeout'); } }); assert.equal(out.annexes.length, 1);
});

test('verification has strict output caps and exact citation membership', async () => {
  const delta = { body_hash: 'd', claims: [{ text: 'Synthetic result.' }] }, impact = { target: { item: 'x' }, cites: [{ quoted: 'Exact frozen quote.' }], why_this_case: 'Synthetic.' };
  await assert.rejects(() => verifyImpact({ delta, impact, askModel: async () => JSON.stringify({ material: true, bears_on: ['paraphrase'], known_unknowns: [], contrary: [] }) }), /citation/);
  await assert.rejects(() => verifyImpact({ delta, impact, askModel: async () => JSON.stringify({ material: true, bears_on: [], known_unknowns: Array(6).fill('x'), contrary: [] }) }), /invalid/);
});

test('reanalysis never reads a leader flag', () => {
  const text = readdirSync(new URL('../reanalysis/', import.meta.url)).filter(name => name.endsWith('.js')).map(name => readFileSync(new URL(`../reanalysis/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(text, /\.leader\b|\bleader\s*:/i);
});
