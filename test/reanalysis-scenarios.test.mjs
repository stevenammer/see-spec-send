import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Store } from '../core/store.js';
import { runReanalysis } from '../reanalysis/run.js';
import { findImpacts } from '../reanalysis/match.js';
import { extractDeltas } from '../knowledge/delta.js';

const stamp = '2026-11-10T12:00:00.000Z';
const later = '2026-11-16T12:00:00.000Z';
let n = 0;

// Dana's SEND was declined for a stated reason; Sam's case later reaches a decision
// that mentions the same subject. Both are synthetic.
function org(t) {
  const s = new Store(); t.after(() => s.close());
  for (const id of ['dana', 'sam']) s.registerPerson(id);
  s.registerPerson('lee', { leader: true });
  const add = (item, event) => s.append(item, { ...event, at: stamp }, { idem: `sc-${++n}` });
  const bind = item => ({ post_id: s.read(item).context.activePost?.id, post_version: s.read(item).context.activePost?.version });
  const decided = (item, actor, spec, packet, extra) => add(item, { type: 'decided', actor: 'lee', spec_hash: spec, packet_hash: packet, ...extra, ...bind(item) });
  function item(name, author, original, assumptions, text) {
    add(name, { type: 'posted', actor: author, original, rules: 3 });
    const see = s.read(name).context.seeHash;
    add(name, { type: 'specced', actor: author, see_hash: see, must: ['Keep the caller note'], how_we_know: ['The note appears'], out_of_scope: [],
      assumptions, open_questions: [], ...bind(name) });
    const spec = s.read(name).context.specHash, packet = s.putArtifact(name, JSON.stringify({ specHash: spec, text }));
    add(name, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(name) });
    return { spec, packet };
  }
  const dana = item('dana', 'dana', 'The handoff loses the caller note.', ['The handoff needs a new integration to carry the caller note.'], 'dana');
  decided('dana', 'lee', dana.spec, dana.packet, { disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration this quarter.', metadata: {} });
  const sam = item('sam', 'sam', 'Night shift cannot see the export.', ['The export permission is the only blocker.'], 'sam');
  return { s, add, bind, dana, sam, decideSam: () => decided('sam', 'lee', sam.spec, sam.packet, { disposition: 'resolve_without_build', reason_code: 'existing',
    reason: 'The existing export already carries the caller note across the handoff, so no integration is needed.', metadata: { alternative: 'Use the export.', action_owner: 'sam' } }) };
}
const fingerprint = (s, item) => ({ events: s.eventRows(item).map(row => row.hash), posts: JSON.stringify(s.db.prepare('SELECT * FROM stage_posts WHERE item=? ORDER BY post_id').all(item)),
  ok: s.verify(item).ok, state: JSON.stringify(s.read(item).context) });

test('a later result reaches an old decline, and the old case is byte-identical', t => {
  const { s, decideSam } = org(t);
  const before = fingerprint(s, 'dana');
  decideSam();
  const out = runReanalysis(s, { now: later });
  assert.equal(out.annexes.length, 1, 'one checked annex on the frozen case');
  const annex = s.knowledge.entries('annex')[0].body;
  assert.equal(annex.parent.item, 'dana');
  assert.equal(annex.authoritative_for_original_stage, false);
  assert.match(annex.statement, /Found by Effort \(AI\)\. This does not change the earlier decision\./);
  assert.ok(annex.bears_on.some(text => /new integration/i.test(text)), 'quotes the earlier assumption exactly');
  assert.deepEqual(fingerprint(s, 'dana'), before, 'event hashes, stage snapshots, verify and state are unchanged');
  assert.deepEqual(s.knowledge.verify(), { ok: true });
});

test('re-running adds nothing, and a restart-style rerun is also a no-op', t => {
  const { s, decideSam } = org(t);
  decideSam();
  runReanalysis(s, { now: later });
  const counts = () => s.knowledge.entries().length;
  const after = counts();
  const again = runReanalysis(s, { now: later });
  assert.equal(again.annexes.length, 0);
  assert.equal(counts(), after);
  assert.equal(runReanalysis(s, { now: '2026-11-17T12:00:00.000Z' }).annexes.length, 0, 'the same pair is never announced twice');
});

test('a burst is bounded by the limit and resumes where it stopped', t => {
  const { s, decideSam } = org(t);
  decideSam();
  const first = runReanalysis(s, { now: later, limit: 1 });
  assert.equal(first.deltas.length, 1);
  const rest = runReanalysis(s, { now: later, limit: 50 });
  assert.ok(first.deltas.length + rest.deltas.length >= 2, 'later deltas are picked up, none repeated');
  const hashes = s.knowledge.entries('delta').map(row => row.body_hash);
  assert.equal(new Set(hashes).size, hashes.length);
});

test('an unrelated result raises no annex', t => {
  const { s, add, bind, sam } = org(t);
  add('sam', { type: 'decided', actor: 'lee', disposition: 'decline', reason_code: 'priority', reason: 'Parking lot signage is not a priority this year.', metadata: {}, spec_hash: sam.spec, packet_hash: sam.packet, ...bind('sam') });
  const out = runReanalysis(s, { now: later });
  assert.equal(out.annexes.length, 0);
  assert.equal(s.knowledge.entries('annex').length, 0);
});

test('a result never reanalyzes the case it came from', t => {
  const { s } = org(t);
  const deltas = extractDeltas(s, { now: later });
  const own = deltas.find(delta => delta.source.item === 'dana');
  assert.ok(own, 'dana decline is itself a recorded result');
  const { checked } = findImpacts(s, own, {});
  assert.ok(checked.every(impact => impact.target.item !== 'dana'));
});

test('generation above 2 is held, never delivered', t => {
  const { s, decideSam } = org(t);
  decideSam();
  const delta = extractDeltas(s, { now: later }).find(row => row.source.item === 'sam');
  const result = findImpacts(s, { ...delta, generation: 3 }, {});
  assert.equal(result.checked.length, 0);
  assert.ok(result.held.length > 0);
});

test('the read gate is applied before delivery: no read access means held, not announced', t => {
  const { s, decideSam } = org(t);
  decideSam();
  const out = runReanalysis(s, { now: later, canRead: (_viewer, scope) => scope.id !== 'dana' });
  assert.equal(out.annexes.length, 0);
  assert.equal(s.knowledge.entries('annex').length, 0);
});

test('an annex adds no item events, cannot build, approve, change steward or count as helps', t => {
  const { s, decideSam } = org(t);
  decideSam();
  const eventCount = item => s.eventRows(item).length;
  const before = { dana: eventCount('dana'), sam: eventCount('sam') };
  const state = JSON.stringify(s.read('dana').context);
  runReanalysis(s, { now: later });
  assert.deepEqual({ dana: eventCount('dana'), sam: eventCount('sam') }, before);
  assert.equal(JSON.stringify(s.read('dana').context), state);
  assert.equal(s.read('dana').context.approval, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0, 'no run was created');
});

test('a minimal stated reason is quoted, not interpreted: no invented condition, threshold or motive', t => {
  const { s, decideSam } = org(t);
  decideSam();
  runReanalysis(s, { now: later });
  const text = JSON.stringify(s.knowledge.entries('annex')[0].body);
  assert.doesNotMatch(text, /threshold|condition_required|motive|because you|you should|reverse|wrong/i);
  assert.ok(s.knowledge.entries('annex').every(row => !('questions' in row.body)), 'no follow-up questions are manufactured');
});

test('static: reanalysis never reads the leader flag, counts people, or touches mentoring tables', () => {
  const files = ['reanalysis', 'knowledge', 'access'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`));
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /\.leader\b|actors\.leader|is_leader/, `${file} must not read the leader flag`);
    assert.doesNotMatch(code, /mentor_/, `${file} must not read mentoring tables`);
    assert.doesNotMatch(code, /GROUP\s+BY\s+actor|count\s*\(.*actor/i, `${file} must not count per person`);
  }
});
