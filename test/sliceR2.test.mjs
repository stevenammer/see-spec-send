import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { EffortGateway } from '../gateway/effort.js';
import { EffortWorker } from '../app/effort.js';
import { lineDiff } from '../core/diff.js';
import { itemPage } from '../app/pages.js';

const at = n => `2026-11-14T00:00:${String(n).padStart(2, '0')}.000Z`;
const append = (store, event, n) => store.append('r2', { ...event, at: at(n) }, { idem: `r2:${n}` });
const setup = () => {
  const store = new Store();
  store.registerPerson('op'); store.registerPerson('maya');
  append(store, { type: 'posted', actor: 'op', original: 'Callers lose context.', rules: 2 }, 1);
  return store;
};

test('R2 N-01: a tagged Effort answer stays beneath its exact triggering comment', async () => {
  const store = setup(); const see = store.read('r2').context.seeHash;
  append(store, { type: 'commented', actor: 'maya', comment: '@effort what breaks next?', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const trigger = store.events('r2').at(-1);
  store.db.prepare("UPDATE effort_jobs SET state='blocked' WHERE kind!='tag'").run();
  const ledger = new Ledger(store); ledger.configure(fixturePolicy());
  const worker = new EffortWorker(store, new EffortGateway(ledger, async () => ({ output: 'Check the handoff.', usage: { input_tokens: 1, output_tokens: 1 } })));
  assert.equal(await worker.tick(), true);
  const answer = store.events('r2').at(-1);
  assert.equal(answer.parent, trigger.body_hash);
  assert.equal(answer.anchor_hash, trigger.anchor_hash);
});

test('R2 N-03: automatic Effort calls do not consume the ten on-demand mentions', () => {
  const store = setup(); const see = store.read('r2').context.seeHash;
  for (let n = 2; n <= 11; n += 1) append(store, { type: 'commented', actor: 'op', comment: `@effort question ${n}`, kind: 'comment', anchor_kind: 'see', anchor_hash: see }, n);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM effort_jobs WHERE kind='tag'").get().n, 10);
  const ledger = new Ledger(store); ledger.configure(fixturePolicy());
  const gateway = new EffortGateway(ledger, async () => ({ output: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));
  const automatic = store.db.prepare("SELECT * FROM effort_jobs WHERE kind='see_first'").get();
  gateway.reserve('op', `automatic:${automatic.id}`, { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }, 'r2', automatic.id);
  for (const job of store.db.prepare("SELECT * FROM effort_jobs WHERE kind='tag' ORDER BY created,id").all()) {
    const outcome = gateway.reserve('op', `mention:${job.id}`, { model: 'fixture:text-v1', input: 'x', max_output_tokens: 1 }, 'r2', job.id);
    assert.equal(outcome.fresh, true);
  }
});

test('R2 N-06: history diff preserves line order and duplicate counts', () => {
  assert.deepEqual(lineDiff('A\nB', 'B\nA'), [
    { kind: 'removed', line: 'A' }, { kind: 'same', line: 'B' }, { kind: 'added', line: 'A' },
  ]);
  assert.deepEqual(lineDiff('A\nA', 'A'), [{ kind: 'same', line: 'A' }, { kind: 'removed', line: 'A' }]);
  // A line moved to the front: the longest common run (A, B) stays 'same'; only the moved line shows as added and removed.
  assert.deepEqual(lineDiff('A\nB\nC', 'C\nA\nB'), [
    { kind: 'added', line: 'C' }, { kind: 'same', line: 'A' }, { kind: 'same', line: 'B' }, { kind: 'removed', line: 'C' },
  ]);
  assert.deepEqual(lineDiff('', ''), []);
});

test('R2 N-04/N-05: the page distinguishes originator from steward and shows attributed credit', () => {
  const store = setup(); const see = store.read('r2').context.seeHash;
  append(store, { type: 'commented', actor: 'maya', comment: 'Keep the caller note.', kind: 'comment', anchor_kind: 'see', anchor_hash: see }, 2);
  const source = store.events('r2').at(-1).body_hash;
  append(store, { type: 'revised', actor: 'op', text: 'Callers lose context. Keep the caller note.', base_hash: see, credits: [{ comment: source, mode: 'quoted' }] }, 3);
  const page = itemPage({ id: 'r2', ...store.read('r2'), effort: [] }, store.events('r2'), 'maya', false);
  assert.match(page.replace(/<[^>]*>/g, ''), /Originator: op\. Current steward: op\./);
  assert.match(page, /href="\/people\/op"/);
  assert.match(page, /credit: maya, quoted/);
  assert.match(page, new RegExp(`href="#comment-${source}"`));
});

test('R2 the Effort prompt always fits the gateway input limit, however long and long-winded the thread', async () => {
  const { effortPrompt } = await import('../effort/prompt.js');
  const long = 'x'.repeat(2000);
  const events = Array.from({ length: 60 }, (_, n) => ({ type: 'commented', actor: `person${n}`, kind: 'comment', comment: `${n} ${long}`, body_hash: 'h'.repeat(64) }));
  const prompt = effortPrompt(long.repeat(5), events);
  assert.ok(Buffer.byteLength(prompt.input) <= 8192, `prompt is ${Buffer.byteLength(prompt.input)} bytes`);
  const parsed = JSON.parse(prompt.input);
  assert.ok(parsed.thread.length > 0, 'the most recent comments are kept');
  assert.equal(parsed.thread.at(-1).text.startsWith('59 '), true, 'the newest comment is the last entry');
  assert.equal(parsed.thread.length + parsed.omitted_comments, 60, 'what was left out is counted');
});
