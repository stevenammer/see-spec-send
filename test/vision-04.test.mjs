import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { EffortGateway } from '../gateway/effort.js';
import { EffortWorker } from '../app/effort.js';

const at = n => `2026-11-13T00:00:${String(n).padStart(2, '0')}.000Z`;
const append = (store, event, n) => store.append('f2', { ...event, at: at(n) }, { idem: `f2:${n}` });
const setup = () => {
  const store = new Store();
  for (const id of ['op', 'member']) store.registerPerson(id);
  store.registerPerson('leader', { leader: true });
  append(store, { type: 'posted', actor: 'op', original: 'The handoff loses the caller context.', rules: 2 }, 1);
  return store;
};

test('F2 tags queue only ten person mentions per day, never agent mentions, and keep the comment', () => {
  const store = setup(); const see = store.read('f2').context.seeHash;
  for (let n = 2; n <= 12; n += 1) append(store, { type: 'commented', actor: 'member', comment: `Question ${n}: @effort`, kind: 'comment', anchor_kind: 'see', anchor_hash: see }, n);
  append(store, { type: 'commented', actor: 'effort', comment: '@effort must not loop', kind: 'agent', job: 'x', receipt: 'x', model: 'fixture', anchor_kind: 'see', anchor_hash: see }, 13);
  assert.equal(store.events('f2').filter(event => event.actor === 'member').length, 11);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM effort_jobs WHERE item='f2' AND kind='tag'").get().n, 10);
});

test('F2 credits a paraphrase, preserves the source, and leader reassignment needs a public note', () => {
  const store = setup(); const see = store.read('f2').context.seeHash;
  append(store, { type: 'commented', actor: 'member', comment: 'Show the last caller note.', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const source = store.events('f2').at(-1).body_hash;
  append(store, { type: 'revised', actor: 'op', text: 'Show the context before transfer.', base_hash: see, credits: [{ comment: source, mode: 'paraphrased' }] }, 3);
  assert.equal(store.events('f2').find(event => event.body_hash === source).comment, 'Show the last caller note.');
  assert.throws(() => append(store, { type: 'steward_changed', actor: 'leader', steward: 'member' }, 4), /event not allowed/);
  append(store, { type: 'steward_changed', actor: 'leader', steward: 'member', reason: 'The original poster is unavailable this week.' }, 5);
  assert.equal(store.read('f2').context.steward, 'member');
});

test('F2 stops at thirty item tags and Effort spec drafts are comments, never specs', async () => {
  const store = setup(); const see = store.read('f2').context.seeHash;
  // Five people rotate so no one reaches their own ten-a-day limit; only the per-item limit of thirty can stop the 31st.
  const crowd = ['op', 'member', 'leader', 'p4', 'p5']; for (const id of ['p4', 'p5']) store.registerPerson(id);
  for (let n = 2; n <= 32; n += 1) append(store, { type: 'commented', actor: crowd[n % 5], comment: `@effort tag ${n}`, kind: 'comment', anchor_kind: 'see', anchor_hash: see }, n);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM effort_jobs WHERE item='f2' AND kind='tag'").get().n, 30);
  const draftStore = setup(); const draftSee = draftStore.read('f2').context.seeHash;
  append(draftStore, { type: 'specced', actor: 'op', see_hash: draftSee, must: ['Keep the handoff'], how_we_know: ['A person reads it'], out_of_scope: [] }, 2);
  draftStore.db.prepare("UPDATE effort_jobs SET state='blocked' WHERE kind!='spec_draft'").run();
  const ledger = new Ledger(draftStore); ledger.configure(fixturePolicy());
  const effort = new EffortGateway(ledger, async () => ({ output: 'Check the edge case.', usage: { input_tokens: 1, output_tokens: 1 } }));
  const worker = new EffortWorker(draftStore, effort);
  await worker.tick();
  assert.equal(draftStore.events('f2').filter(event => event.type === 'specced').length, 1);
  const draft = draftStore.events('f2').find(event => event.type === 'commented' && event.actor === 'effort');
  assert.ok(draft, JSON.stringify(draftStore.db.prepare("SELECT kind,state,last_error FROM effort_jobs WHERE kind='spec_draft'").get()));
  assert.match(draft?.comment, /Use as starting point/);
});
