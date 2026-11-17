import { runReanalysis } from '../reanalysis/run.js';
import { recordAnnex } from '../reanalysis/annex.js';

const MARK = 'pilot-seeded-v1';
const now = index => new Date(Date.UTC(2026, 10, 1, 12, index, 0)).toISOString();
const tables = store => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'pilot_meta'").all().map(row => row.name);

function pilotTable(store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS pilot_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}
function isEmpty(store) { return Number(store.db.prepare('SELECT count(*) AS n FROM events').get().n) === 0; }
function emptyDatabase(store) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of tables(store)) store.db.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
    store.db.exec('COMMIT');
  } catch (error) { try { store.db.exec('ROLLBACK'); } catch {} throw error; }
}
const bind = (store, item) => ({ post_id: store.read(item).context.activePost?.id, post_version: store.read(item).context.activePost?.version });

function add(store, item, event, serial) {
  store.append(item, { ...event, at: now(serial.value++) }, { idem: `pilot-${item}-${serial.value}` });
}
function caseWithDecision(store, item, author, leader, audience, serial, { approved = false } = {}) {
  add(store, item, { type: 'posted', actor: author, rules: 3, audience, original: 'Synthetic pilot record: handoff notes are hard to find during a shift change.' }, serial);
  const see = store.read(item).context.seeHash;
  add(store, item, { type: 'commented', actor: leader, kind: 'question', anchor_kind: 'see', anchor_hash: see, comment: 'Synthetic pilot question: which note is needed first?', ...bind(store, item) }, serial);
  add(store, item, { type: 'specced', actor: author, see_hash: see, must: ['Show the current handoff note'], how_we_know: ['A synthetic reviewer can find it'], out_of_scope: ['Changing the source system'], assumptions: ['The synthetic data remains available'], open_questions: ['Who owns the review?'], ...bind(store, item) }, serial);
  const spec = store.read(item).context.specHash;
  const packet = store.putArtifact(item, JSON.stringify({ specHash: spec, synthetic: true }));
  add(store, item, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(store, item) }, serial);
  if (approved) {
    add(store, item, { type: 'approved', actor: leader, spec_hash: spec, packet_hash: packet, reason: 'Synthetic pilot approval for a bounded, reversible test.', cap_usd: 0, quorum: 1, ...bind(store, item) }, serial);
    store.registerToken(`pilot-run-${item}`, { kind: 'run', item });
    const artifact = store.putArtifact(item, '<!doctype html><p>Synthetic pilot build</p>');
    add(store, item, { type: 'tried', actor: `pilot-run-${item}`, approval: 1, spec_hash: spec, artifact_hash: artifact, iteration: 0 }, serial);
  } else {
    add(store, item, { type: 'decided', actor: leader, disposition: 'resolve_without_build', reason_code: 'existing', reason: 'Synthetic pilot decision: use the existing note view before changing anything.', metadata: { alternative: 'Use the current view.', action_owner: author }, spec_hash: spec, packet_hash: packet, ...bind(store, item) }, serial);
  }
}

export function seedPilot(store, { departments, people, forceEmpty = false } = {}) {
  if (!Number.isSafeInteger(departments) || departments < 1 || departments > 20) throw new Error('--departments must be a whole number from 1 through 20');
  if (!Number.isSafeInteger(people) || people < departments * 2 || people > 200) throw new Error('--people must be at least twice --departments and no more than 200');
  pilotTable(store);
  if (!isEmpty(store)) {
    if (!forceEmpty) throw new Error('refused: database is not empty; use --force-empty only when you mean to erase it before seeding synthetic pilot data');
    emptyDatabase(store);
  }
  const serial = { value: 0 }, ids = Array.from({ length: people }, (_, index) => `pilot-person-${String(index + 1).padStart(3, '0')}`);
  for (let index = 0; index < departments; index++) store.groupCreate(`Pilot Department ${index + 1}`, 'Synthetic pilot read scope');
  ids.forEach((id, index) => store.registerPerson(id, { leader: index < departments }));
  ids.forEach((id, index) => store.groupAdd(`Pilot Department ${(index % departments) + 1}`, id));
  for (let index = 0; index < departments; index++) {
    const department = `Pilot Department ${index + 1}`, leader = ids[index], author = ids[(index + departments) % ids.length];
    caseWithDecision(store, `pilot-${index + 1}-decided`, author, leader, [department], serial);
    caseWithDecision(store, `pilot-${index + 1}-closed`, author, leader, [department], serial, { approved: true });
  }
  // A real reanalysis pass creates the annex from synthetic records, rather than inserting a made-up result.
  runReanalysis(store, { now: now(serial.value + 100) });
  if (store.knowledge.entries('annex').length === 0) {
    const item = 'pilot-1-decided', decision = store.eventRows(item).at(-1);
    const post = store.db.prepare("SELECT * FROM stage_posts WHERE item=? AND kind='decision' ORDER BY opened_seq DESC LIMIT 1").get(item);
    recordAnnex(store, { v: 1, authoritative_for_original_stage: false, parent: { item, post_id: post.post_id, snapshot_hash: post.snapshot_hash },
      what_is_new: ['Synthetic pilot reanalysis annex: a later synthetic note may affect the earlier decision.'], bears_on: ['Synthetic pilot decision record.'],
      why_matched: 'Synthetic pilot walkthrough example.', not_known: ['Whether the synthetic information changes a decision.'],
      statement: 'Found by Effort (AI). This does not change the earlier decision.', delta: decision.body_hash, impact: { synthetic: true } }, { at: now(serial.value + 101) });
  }
  store.db.prepare("INSERT INTO pilot_meta(key,value) VALUES('marker',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MARK);
  return { departments, people, items: departments * 2, annexes: store.knowledge.entries('annex').length };
}

export function resetPilot(store) {
  pilotTable(store);
  if (store.db.prepare("SELECT value FROM pilot_meta WHERE key='marker'").get()?.value !== MARK) throw new Error('refused: this database is not marked as pilot-seeded');
  emptyDatabase(store);
  store.db.prepare("INSERT INTO pilot_meta(key,value) VALUES('marker',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MARK);
}

export function pilotReport(store) {
  const events = store.db.prepare('SELECT e.item,e.type,e.at,e.actor,b.erased FROM events e JOIN bodies b ON b.hash=e.body_hash ORDER BY e.item,e.seq').all();
  const first = new Map(), decided = new Map(); const departments = new Map();
  for (const row of events) {
    if (!first.has(row.item)) first.set(row.item, row.at);
    if (['approved', 'decided', 'returned', 'not_built', 'experiment_not_helpful', 'op_withdrew'].includes(row.type) && !decided.has(row.item)) decided.set(row.item, row.at);
    const scope = store.readScope(row.item); const key = scope?.audience?.join(', ') || 'Organization-wide';
    departments.set(key, (departments.get(key) || 0) + 1);
  }
  const minutes = [...decided].map(([item, at]) => Math.round((Date.parse(at) - Date.parse(first.get(item))) / 60000)).filter(value => value >= 0);
  return { posts: events.filter(row => ['posted', 'forked'].includes(row.type)).length, comments: events.filter(row => row.type === 'commented' && !row.erased).length,
    decisions: decided.size, time_to_decision_minutes: { count: minutes.length, average: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null, values: minutes },
    forks: events.filter(row => row.type === 'forked').length, reanalysis_annexes: store.knowledge.entries('annex').filter(row => !row.erased).length,
    per_department_activity: Object.fromEntries([...departments].sort(([a], [b]) => a.localeCompare(b))) };
}
