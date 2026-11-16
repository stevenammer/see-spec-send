import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { runReanalysis } from '../reanalysis/run.js';
import { challengeClaim } from '../knowledge/corrections.js';

const stamp = '2026-11-10T12:00:00.000Z', later = '2026-11-16T12:00:00.000Z';
const ERASED_PHRASE = 'existing export already carries the caller note';
let n = 0;

// A small organization with every kind of data that has to survive a move.
function organization(t) {
  const s = new Store(); t.after(() => s.close());
  for (const id of ['dana', 'sam', 'pat']) s.registerPerson(id); s.registerPerson('lee', { leader: true });
  s.groupCreate('Reservations', 'Night shift and reservations'); s.groupAdd('Reservations', 'sam'); s.groupAdd('Reservations', 'lee');
  const add = (item, event) => s.append(item, { ...event, at: stamp }, { idem: `ex-${++n}` });
  const bind = item => ({ post_id: s.read(item).context.activePost?.id, post_version: s.read(item).context.activePost?.version });
  const item = (name, author, original, assumption, extra = {}) => {
    add(name, { type: 'posted', actor: author, original, rules: 3, ...extra });
    add(name, { type: 'specced', actor: author, see_hash: s.read(name).context.seeHash, must: ['Keep the caller note'], how_we_know: ['The note appears'], out_of_scope: [], assumptions: [assumption], open_questions: [], ...bind(name) });
    const spec = s.read(name).context.specHash, packet = s.putArtifact(name, JSON.stringify({ specHash: spec }));
    add(name, { type: 'sent', actor: author, spec_hash: spec, packet_hash: packet, ...bind(name) });
    return { spec_hash: spec, packet_hash: packet };
  };
  const d = item('dana', 'dana', 'The handoff loses the caller note.', 'The handoff needs a new integration to carry the caller note.');
  add('dana', { type: 'decided', actor: 'lee', disposition: 'decline', reason_code: 'budget', reason: 'No budget for a new integration this quarter.', metadata: {}, ...d, ...bind('dana') });
  const m = item('sam', 'sam', 'Night shift cannot see the export.', 'The export permission is the only blocker.');
  add('sam', { type: 'decided', actor: 'lee', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'The existing export covers it, so no integration is needed.', metadata: { alternative: 'Use the export.', action_owner: 'sam' }, ...m, ...bind('sam') });
  // A spec that carries the wording to be erased later, and whose estimates make it a recorded result.
  add('kim', { type: 'posted', actor: 'sam', original: 'Another handoff problem.', rules: 3 });
  add('kim', { type: 'specced', actor: 'sam', see_hash: s.read('kim').context.seeHash, must: [`The ${ERASED_PHRASE} across the handoff, so no new integration is needed.`], how_we_know: ['It works'], out_of_scope: [],
    assumptions: ['Some other assumption.'], open_questions: [], estimates: [{ dimension: 'people_time', low: 1, high: 2, unit: 'days', basis: [], unknowns: [], alternatives: [] }], ...bind('kim') });
  add('secret', { type: 'posted', actor: 'sam', original: 'Restricted night shift detail ZEBRA-7731.', rules: 3, audience: ['Reservations'] });
  runReanalysis(s, { now: later });
  const decision = s.events('dana').find(e => e.type === 'decided');
  challengeClaim(s, { target: decision.body_hash, actor: 'dana', note: 'Context: an existing export covers this.', at: later });
  return { s, kimSpec: s.events('kim').find(e => e.type === 'specced') };
}
const hashes = store => store.knowledge.entries().map(row => row.hash);

test('an export carries groups, the knowledge log, corrections and delivery state, and an import restores them exactly', t => {
  const { s } = organization(t);
  assert.ok(s.knowledge.entries('annex').length > 0 && s.knowledge.entries('correction').length === 1 && s.db.prepare('SELECT COUNT(*) AS n FROM digest_entries').get().n > 0, 'the fixture has what it should');
  const exported = s.exportJsonl();
  const b = new Store(); t.after(() => b.close()); b.importJsonl(exported);
  assert.ok(b.verifyAll().every(row => row.ok), 'every item chain verifies'); assert.ok(b.knowledge.verify().ok, 'the knowledge chain verifies');
  assert.deepEqual(hashes(b), hashes(s), 'the same records in the same order with the same hashes');
  assert.deepEqual(b.groups(), s.groups());
  assert.equal(b.canRead('sam', 'secret'), true); assert.equal(b.canRead('pat', 'secret'), false, 'restricted work stays restricted after the move');
  for (const table of ['digest_entries', 'ping_log', 'reanalysis_pairs', 'reanalysis_cursor']) assert.deepEqual(b.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(), s.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(), table);
  const before = { log: b.knowledge.entries().length, digest: b.db.prepare('SELECT COUNT(*) AS n FROM digest_entries').get().n };
  const again = runReanalysis(b, { now: later });
  assert.equal(again.annexes.length, 0, 'an imported copy does not announce everything again');
  assert.deepEqual({ log: b.knowledge.entries().length, digest: b.db.prepare('SELECT COUNT(*) AS n FROM digest_entries').get().n }, before);
});

test('erased text never leaves in an export, its record keeps only its hashes, and the copy still verifies', t => {
  const { s, kimSpec } = organization(t);
  assert.ok(s.exportJsonl().includes(ERASED_PHRASE), 'before the erase the wording is in the export');
  s.erase('kim', kimSpec.body_hash, 'lee', later, { ground: 'privacy', note: 'Synthetic erasure' });
  assert.ok(s.knowledge.entries().some(row => row.erased), 'derived records were tombstoned by the erase');
  const exported = s.exportJsonl();
  assert.ok(!exported.includes(ERASED_PHRASE), 'the erased wording is not in the export, in events or in derived records');
  assert.ok(exported.includes('"redacted":true'));
  const b = new Store(); t.after(() => b.close()); b.importJsonl(exported);
  assert.ok(b.knowledge.verify().ok); assert.deepEqual(hashes(b), hashes(s));
  assert.ok(b.knowledge.entries().filter(row => row.erased).length > 0);
  assert.ok(!JSON.stringify(b.knowledge.entries()).includes(ERASED_PHRASE));
  assert.ok(!b.exportJsonl().includes(ERASED_PHRASE), 'and a second export from the copy stays clean');
});

test('accounts, passwords and private mentoring are not exported', t => {
  const { s } = organization(t);
  s.db.prepare('INSERT INTO users(id,password,leader) VALUES(?,?,0)').run('someone', 'scrypt$secret-hash-material');
  const exported = s.exportJsonl();
  assert.ok(!exported.includes('scrypt$') && !exported.includes('secret-hash-material'));
  assert.ok(!/mentor_/i.test(exported));
});

test('imports refuse a tampered record, a missing line, and a destination that already has a knowledge log, and old exports still import', t => {
  const { s } = organization(t); const exported = s.exportJsonl(); const lines = exported.trim().split('\n');
  const fresh = () => { const store = new Store(); t.after(() => store.close()); return store; };
  const tampered = lines.map(line => { const row = JSON.parse(line); if (row.knowledge && row.knowledge.kind === 'receipt' && !row.knowledge.redacted && !row.__done) { row.knowledge.body = row.knowledge.body.replace('"v":1', '"v":2'); row.__done = true; } return JSON.stringify(row); }).join('\n') + '\n';
  assert.throws(() => fresh().importJsonl(tampered), /does not verify|bad import/);
  const missing = lines.filter((line, index) => !(JSON.parse(line).group && index === lines.findIndex(l => JSON.parse(l).group))).join('\n') + '\n';
  assert.throws(() => fresh().importJsonl(missing), /incomplete import/);
  const lastKnowledge = lines.map(line => JSON.parse(line)).filter(row => row.knowledge).length;
  assert.ok(lastKnowledge > 0);
  const occupied = fresh(); occupied.importJsonl(exported);
  assert.throws(() => occupied.importJsonl(exported), /not empty|already|exists|duplicate|UNIQUE|constraint/i, 'two knowledge logs cannot be merged');
  // An export made before groups and the knowledge log existed carries neither, and must still import.
  // (Restricted work did not exist then either, so the synthetic old export leaves that item out.)
  const legacy = lines.filter(line => { const row = JSON.parse(line); return row.complete || (!row.group && !row.knowledge && !row.tombstone && !row.derived && row.item !== 'secret'); });
  const footer = JSON.parse(legacy.pop()); delete footer.groups; delete footer.knowledge; delete footer.tombstones; delete footer.derived;
  footer.events = legacy.filter(line => { const row = JSON.parse(line); return !row.registry && !row.artifact; }).length; legacy.push(JSON.stringify(footer));
  const old = fresh(); old.importJsonl(`${legacy.join('\n')}\n`);
  assert.ok(old.verifyAll().every(row => row.ok)); assert.equal(old.knowledge.entries().length, 0);
});

import { main as cli } from '../cli.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the import command loads an export into a new database, refuses an existing one, and cleans up after a bad file', async t => {
  const { s } = organization(t); const dir = mkdtempSync(join(tmpdir(), 'sss-import-')); const exportFile = join(dir, 'org.jsonl'); writeFileSync(exportFile, s.exportJsonl());
  const out = []; const target = join(dir, 'new.db');
  assert.equal(await cli(['import', '--from', exportFile], { SSS_DB: target }, line => out.push(line)) ?? 0, 0);
  const summary = JSON.parse(out[0]); assert.ok(summary.items >= 4); assert.ok(summary.knowledge_records > 0); assert.equal(summary.groups, 1); assert.match(summary.next, /No accounts are imported/);
  await assert.rejects(cli(['import', '--from', exportFile], { SSS_DB: target }, () => {}), /new database/, 'an existing database is never overwritten');
  const bad = join(dir, 'bad.jsonl'); writeFileSync(bad, '{"registry":{"id":"x","kind":"person","leader":0}}\n{"complete":true,"events":9,"actors":1}\n');
  const half = join(dir, 'half.db');
  await assert.rejects(cli(['import', '--from', bad], { SSS_DB: half }, () => {}), /incomplete import/);
  assert.equal(existsSync(half), false, 'a failed import leaves no database behind');
  await assert.rejects(cli(['import'], { SSS_DB: join(dir, 'x.db') }, () => {}), /missing --from/);
});

test('import resets leader authority by default, keeps it only when asked, and a signed export is verified before anything is loaded', async t => {
  const { s } = organization(t); assert.equal(s.actor('lee', '').leader, true);
  const plain = new Store(); t.after(() => plain.close()); plain.importJsonl(s.exportJsonl());
  assert.equal(plain.actor('lee', '').leader, false, 'nobody imports current leader authority');
  assert.ok(plain.verifyAll().every(row => row.ok), 'past decisions by a leader still verify and replay');
  const kept = new Store(); t.after(() => kept.close()); kept.importJsonl(s.exportJsonl(), { keepAuthority: true });
  assert.equal(kept.actor('lee', '').leader, true);
  // Signing, through the real commands.
  const dir = mkdtempSync(join(tmpdir(), 'sss-sign-')); const key = join(dir, 'export.key'); const file = join(dir, 'org.db'); const source = new Store(file); source.importJsonl(s.exportJsonl(), { keepAuthority: true }); source.close();
  const out = []; await cli(['export', '--sign-key', key], { SSS_DB: file }, line => out.push(line)); const signed = out.join('\n');
  assert.match(signed, /\n\{"signature":"hmac-sha256:[a-f0-9]{64}"\}\n?$/); writeFileSync(join(dir, 'signed.jsonl'), signed.endsWith('\n') ? signed : `${signed}\n`);
  const ok = join(dir, 'ok.db'); const summary = []; await cli(['import', '--from', join(dir, 'signed.jsonl'), '--verify-key', key], { SSS_DB: ok }, line => summary.push(line));
  assert.match(summary[0], /"items"/); assert.equal(new Store(ok).actor('lee', '').leader, false);
  const tampered = join(dir, 'tampered.jsonl'); writeFileSync(tampered, readFileSync(join(dir, 'signed.jsonl'), 'utf8').replace('"leader":1', '"leader":0').replace('Restricted night shift', 'Changed text here'));
  await assert.rejects(cli(['import', '--from', tampered, '--verify-key', key], { SSS_DB: join(dir, 't.db') }, () => {}), /signature does not match/);
  assert.equal(existsSync(join(dir, 't.db')), false, 'nothing is created for a file that fails verification');
  const unsigned = join(dir, 'unsigned.jsonl'); writeFileSync(unsigned, s.exportJsonl());
  await assert.rejects(cli(['import', '--from', unsigned, '--verify-key', key], { SSS_DB: join(dir, 'u.db') }, () => {}), /not signed/);
  const other = join(dir, 'other.key'); writeFileSync(other, Buffer.alloc(32, 7));
  await assert.rejects(cli(['import', '--from', join(dir, 'signed.jsonl'), '--verify-key', other], { SSS_DB: join(dir, 'w.db') }, () => {}), /signature does not match/, 'the wrong key');
  const fresh = join(dir, 'k.db'); await cli(['import', '--from', join(dir, 'signed.jsonl'), '--keep-leaders'], { SSS_DB: fresh }, () => {}); assert.equal(new Store(fresh).actor('lee', '').leader, true);
});
