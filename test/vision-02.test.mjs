import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { EffortGateway } from '../gateway/effort.js';
import { EffortWorker } from '../app/effort.js';
import { Worker } from '../worker/runner.js';

const at = n => `2026-11-13T00:00:0${n}.000Z`;
const append = (store, item, event, n) => store.append(item, { ...event, at: at(n) }, { idem: `${item}:${n}` });
const people = store => { store.registerPerson('op'); store.registerPerson('member'); store.registerPerson('leader', { leader: true }); };
const posted = store => {
  append(store, 'item', { type: 'posted', actor: 'op', original: 'The customer handoff loses important context.', rules: 2 }, 1);
  return store.read('item').context.seeHash;
};
const ready = store => {
  const see = posted(store);
  append(store, 'item', { type: 'specced', actor: 'op', see_hash: see, must: ['keep handoff context'], how_we_know: ['a person can review it'], out_of_scope: [] }, 2);
  const spec = store.read('item').context.specHash;
  const packet = store.putArtifact('item', JSON.stringify({ specHash: spec }));
  append(store, 'item', { type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet }, 3);
  append(store, 'item', { type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'This small sandbox is independently reviewed.', cap_usd: 1, quorum: 1 }, 4);
  return { see, spec };
};

test('F1 Effort posts exactly one first comment, even after the call/append crash window', async () => {
  const store = new Store(); people(store); const ledger = new Ledger(store); ledger.configure(fixturePolicy());
  const effort = new EffortGateway(ledger, async () => ({ output: 'What happens when the handoff reaches the next person?', usage: { input_tokens: 4, output_tokens: 7 } }));
  const see = posted(store); const worker = new EffortWorker(store, effort);
  await worker.tick({ crashAfterCall: true });
  await worker.tick();
  await worker.tick();
  const comments = store.events('item').filter(event => event.type === 'commented');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].actor, 'effort');
  assert.equal(comments[0].kind, 'agent');
  assert.equal(comments[0].anchor_hash, see);
  assert.equal(store.db.prepare("SELECT state FROM effort_jobs WHERE item='item'").get().state, 'done');
  // Simulate a process death after the append committed but before the job status did.
  store.db.prepare("UPDATE effort_jobs SET state='running' WHERE item='item'").run();
  await worker.tick();
  assert.equal(store.events('item').filter(event => event.type === 'commented').length, 1);
  // A requeue (a new attempt number) must still not add a second first comment: the comment's own key has no attempt in it.
  store.db.prepare("UPDATE effort_jobs SET state='queued' WHERE item='item'").run();
  await worker.tick();
  assert.equal(store.events('item').filter(event => event.type === 'commented').length, 1);
});

test('F1 enqueues Effort for every new SEE, fork, and only the first Spec', () => {
  const store = new Store(); people(store);
  const see = posted(store);
  append(store, 'item', { type: 'specced', actor: 'op', see_hash: see, must: ['first'], how_we_know: ['check'], out_of_scope: [] }, 2);
  append(store, 'item', { type: 'specced', actor: 'op', see_hash: see, must: ['second'], how_we_know: ['check'], out_of_scope: [] }, 3);
  const parent = store.db.prepare("SELECT seq,hash FROM events WHERE item='item' AND seq=1").get();
  append(store, 'fork', { type: 'forked', actor: 'member', original: 'A separate branch.', rules: 2, parent: { item: 'item', seq: parent.seq, hash: parent.hash } }, 1);
  assert.deepEqual(store.db.prepare('SELECT item,kind FROM effort_jobs ORDER BY item,kind').all().map(row => ({ ...row })), [
    { item: 'fork', kind: 'see_first' }, { item: 'item', kind: 'see_first' }, { item: 'item', kind: 'spec_first' },
  ]);
});

test('F1 Effort leaves the post visible with an honest failure, disabled, and kill-latch status without calling', async () => {
  for (const mode of ['failed', 'disabled', 'killed']) {
    const store = new Store(); people(store); const ledger = new Ledger(store);
    ledger.configure(fixturePolicy(mode === 'disabled' ? { enabled: false } : {}));
    let calls = 0;
    const effort = new EffortGateway(ledger, async () => { calls += 1; if (mode === 'failed') throw Error('provider unavailable'); return { output: 'no', usage: { input_tokens: 1, output_tokens: 1 } }; });
    posted(store);
    if (mode === 'killed') store.db.prepare('UPDATE worker_control SET killed=1 WHERE id=1').run();
    await new EffortWorker(store, effort).tick();
    const job = store.db.prepare("SELECT state,last_error FROM effort_jobs WHERE item='item'").get();
    assert.equal(calls, mode === 'failed' ? 1 : 0);
    assert.equal(job.state, mode === 'failed' ? 'queued' : 'blocked');
    assert.match(job.last_error, mode === 'disabled' ? /not turned on|disabled/ : mode === 'killed' ? /stopped/ : /failed/);
  }
});

test('F1 Effort uses a sealed, per-person capped receipt and counts in global and day caps', async () => {
  const store = new Store(); people(store); const ledger = new Ledger(store);
  ledger.configure(fixturePolicy());
  const effort = new EffortGateway(ledger, async () => ({ output: 'A useful question.', usage: { input_tokens: 1, output_tokens: 1 } }));
  posted(store);
  await new EffortWorker(store, effort).tick();
  const receipt = effort.receipts()[0];
  assert.equal(receipt.state, 'settled');
  effort.reserve('op', 'another', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 16 }, 'item', 'job');
  effort.reserve('op', 'third', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 16 }, 'item', 'job');
  assert.throws(() => effort.reserve('op', 'fourth', { model: 'fixture:text-v1', input: 'x', max_output_tokens: 16 }, 'item', 'job'), /person daily call limit/);
  store.db.prepare("UPDATE gateway_effort_receipts SET seal='bad' WHERE id=?").run(receipt.id);
  assert.throws(() => effort.receipts(), /corrupt Effort receipt/);
});

test('F1 builder receives only OP steered instructions and shares the approval cap across iterations', () => {
  const store = new Store(); people(store); const { spec } = ready(store);
  append(store, 'item', { type: 'commented', actor: 'member', comment: 'Never send this raw comment to the builder.', kind: 'concern', anchor_kind: 'spec', anchor_hash: spec }, 5);
  append(store, 'item', { type: 'steered', actor: 'op', approval: 1, spec_hash: spec, instruction: 'Keep the handoff summary short.' }, 6);
  const worker = new Worker(store); worker.reconcile();
  const run = store.db.prepare("SELECT * FROM runs WHERE item='item' ORDER BY iteration DESC LIMIT 1").get();
  const request = JSON.parse(store.db.prepare('SELECT input FROM fake_jobs WHERE id=?').get(run.id).input);
  assert.deepEqual(request.instructions, [{ instruction: 'Keep the handoff summary short.', actor: 'op', source: null, mode: null }]);
  assert.doesNotMatch(JSON.stringify(request), /Never send this raw comment/);
  assert.match(store.artifact('item', store.read('item').context.artifact), /Fixture builder\. No model wrote this\./);
});
