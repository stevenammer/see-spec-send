import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store.js';
import { pilotReport, resetPilot, seedPilot } from '../pilot/kit.js';
import { handoffPackage } from '../handoff/export.js';

test('pilot seed makes scoped synthetic records, an annex, report data, and only resets marked databases', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-pilot-')), file = join(dir, 'pilot.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(file); const result = seedPilot(store, { departments: 2, people: 6 });
  assert.equal(result.items, 4); assert.ok(result.annexes >= 1); assert.equal(store.canRead('pilot-person-001', 'pilot-1-decided'), true);
  assert.equal(store.canRead('pilot-person-001', 'pilot-2-decided'), false);
  assert.equal(pilotReport(store).decisions, 4); assert.ok(pilotReport(store).reanalysis_annexes >= 1);
  assert.throws(() => seedPilot(store, { departments: 1, people: 2 }), /not empty/);
  store.close(); store = new Store(file); t.after(() => { try { store.close(); } catch {} });
  resetPilot(store); assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
  store.close(); store = new Store(file); assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
});

test('pilot reset refuses an ordinary database', t => {
  const store = new Store(); t.after(() => store.close()); store.registerPerson('person');
  assert.throws(() => resetPilot(store), /not marked/);
});

test('handoff requires read access and excludes erased comment text', t => {
  const store = new Store(); t.after(() => store.close());
  for (const id of ['author', 'reader', 'outsider']) store.registerPerson(id); store.registerPerson('leader', { leader: true });
  store.groupCreate('Pilot', 'Synthetic'); store.groupAdd('Pilot', 'author'); store.groupAdd('Pilot', 'reader'); store.groupAdd('Pilot', 'leader');
  let n = 0; const add = event => store.append('item', { ...event, at: new Date(1800000000000 + ++n * 1000).toISOString() }, { idem: `handoff-${n}` });
  const bind = () => ({ post_id: store.read('item').context.activePost.id, post_version: store.read('item').context.activePost.version });
  add({ type: 'posted', actor: 'author', rules: 3, audience: ['Pilot'], original: 'Synthetic handoff problem.' }); const see = store.read('item').context.seeHash;
  add({ type: 'commented', actor: 'reader', kind: 'comment', anchor_kind: 'see', anchor_hash: see, comment: 'erase this text', ...bind() }); const comment = store.events('item').at(-1).body_hash;
  add({ type: 'specced', actor: 'author', see_hash: see, must: ['Keep the synthetic note'], how_we_know: ['A reviewer finds it'], out_of_scope: [], assumptions: ['Synthetic assumption'], open_questions: ['Synthetic question'], ...bind() }); const spec = store.read('item').context.specHash;
  const packet = store.putArtifact('item', JSON.stringify({ specHash: spec })); add({ type: 'sent', actor: 'author', spec_hash: spec, packet_hash: packet, ...bind() });
  add({ type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'Synthetic bounded approval.', cap_usd: 0, quorum: 1, ...bind() });
  store.erase('item', comment, 'reader', new Date(1800000000000 + ++n * 1000).toISOString());
  const packetOut = handoffPackage(store, { item: 'item', actor: 'reader' }); assert.doesNotMatch(JSON.stringify(packetOut), /erase this text/); assert.equal(packetOut.erased_text_included, false);
  assert.throws(() => handoffPackage(store, { item: 'item', actor: 'outsider' }), /cannot read/);
});

test('pilot reset over the command line needs the explicit erase-everything flag and then really empties the database', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sss-pilot-')), 'p.db'); const env = { ...process.env, SSS_DB: file };
  const run = args => spawnSync(process.execPath, ['cli.js', ...args], { cwd: new URL('..', import.meta.url).pathname, env, encoding: 'utf8' });
  assert.equal(run(['init', '--id', 'admin']).status, 0);
  assert.equal(run(['pilot', 'seed', '--departments', '2', '--people', '4']).status, 0);
  const refused = run(['pilot', 'reset']); assert.notEqual(refused.status, 0); assert.match(refused.stderr + refused.stdout, /confirm-erase-everything/);
  assert.equal(run(['pilot', 'reset', '--confirm-erase-everything']).status, 0);
  assert.equal(JSON.parse(run(['pilot', 'report']).stdout).posts, 0);
});
