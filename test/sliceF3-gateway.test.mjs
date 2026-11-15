import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';

function setup(t) {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('op'); store.registerPerson('leader', { leader: true });
  const start = Date.parse('2026-11-14T12:00:00.000Z'); let now = start, seq = 0;
  const append = event => store.append('budget', { ...event, at: new Date(now).toISOString() }, { idem: `budget:${seq++}` });
  append({ type: 'posted', actor: 'op', rules: 2, original: 'Preserve the transfer note.' });
  append({ type: 'specced', actor: 'op', see_hash: store.read('budget').context.seeHash, must: ['Show the note'], how_we_know: ['Transfer preserves it'], out_of_scope: [] });
  const spec_hash = store.read('budget').context.specHash;
  const packet_hash = store.putArtifact('budget', JSON.stringify({ specHash: spec_hash }));
  append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
  append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, reason: 'Bound the total spend across all turns.', cap_usd: 0.00005, quorum: 1, window_minutes: 1, max_iterations: 2 });
  const adapter = { start() {}, status: () => ({ state: 'running' }), stop: () => ({ state: 'stopped' }) };
  const worker = new Worker(store, adapter, { clock: () => now }); worker.reconcile();
  const ledger = new Ledger(store, { clock: () => now }); ledger.configure(fixturePolicy());
  const run = () => store.db.prepare('SELECT * FROM runs WHERE status=\'active\' ORDER BY iteration DESC').get();
  return { store, worker, ledger, append, spec_hash, run, setNow: value => { now = value; }, start };
}
const input = { model: 'fixture:text-v1', input: 'hello', max_output_tokens: 10 }; // 33 micros worst case

test('F3 gateway refuses spend and capability minting at approval expiry before worker reconciliation', t => {
  const { ledger, run, start, setNow } = setup(t);
  const token = ledger.mint(run().id);
  setNow(start + 60_000);
  assert.throws(() => ledger.mint(run().id), /approval window expired/);
  assert.throws(() => ledger.reserve(token, 'late', input), /approval window expired/);
  assert.equal(ledger.receipts().length, 0);
});

test('F3 gateway charges every build turn against one approved total cap', t => {
  const { ledger, worker, append, spec_hash, run } = setup(t);
  const first = ledger.mint(run().id);
  assert.equal(ledger.reserve(first, 'first', input).row.worst_micros, 33);
  append({ type: 'steered', actor: 'op', approval: 1, spec_hash, instruction: 'Move the note above transfer.' });
  worker.reconcile();
  const second = ledger.mint(run().id);
  assert.equal(run().iteration, 1);
  assert.throws(() => ledger.reserve(second, 'second', input), /run cap exceeded/);
  assert.equal(ledger.receipts().length, 1);
});
