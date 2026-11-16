import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';

// A free (price-zero) model makes dollar caps vacuous. These per-run ceilings
// bound a run by call count and by worst-case tokens regardless of price.
function setup(t, policy) {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('op'); store.registerPerson('leader', { leader: true });
  let now = Date.parse('2026-11-16T12:00:00.000Z'), seq = 0;
  const append = event => store.append('lim', { ...event, at: new Date(now).toISOString() }, { idem: `lim:${seq++}` });
  append({ type: 'posted', actor: 'op', rules: 2, original: 'Preserve the transfer note.' });
  append({ type: 'specced', actor: 'op', see_hash: store.read('lim').context.seeHash, must: ['Show the note'], how_we_know: ['Transfer preserves it'], out_of_scope: [] });
  const spec_hash = store.read('lim').context.specHash;
  const packet_hash = store.putArtifact('lim', JSON.stringify({ specHash: spec_hash }));
  append({ type: 'sent', actor: 'op', spec_hash, packet_hash });
  append({ type: 'approved', actor: 'leader', spec_hash, packet_hash, reason: 'Plenty of dollars; the limit under test is calls and tokens.', cap_usd: 1, quorum: 1, window_minutes: 60, max_iterations: 2 });
  const adapter = { start() {}, status: () => ({ state: 'running' }), stop: () => ({ state: 'stopped' }) };
  new Worker(store, adapter, { clock: () => now }).reconcile();
  const ledger = new Ledger(store, { clock: () => now }); ledger.configure(fixturePolicy(policy));
  const run = store.db.prepare("SELECT * FROM runs WHERE status='active' ORDER BY iteration DESC").get();
  return { ledger, token: ledger.mint(run.id) };
}
const input = { model: 'fixture:text-v1', input: 'hello', max_output_tokens: 10 };

test('a per-run call limit refuses call N+1 even with dollars to spare', t => {
  const { ledger, token } = setup(t, { max_calls_per_run: 2 });
  ledger.reserve(token, 'a', input); ledger.reserve(token, 'b', input);
  assert.throws(() => ledger.reserve(token, 'c', input), /run call limit exceeded/);
  assert.equal(ledger.receipts().length, 2);
});

test('a retry of an existing call is not a new call', t => {
  const { ledger, token } = setup(t, { max_calls_per_run: 1 });
  ledger.reserve(token, 'a', input);
  assert.equal(ledger.reserve(token, 'a', input).fresh, false);
});

test('a per-run token limit counts worst-case tokens', t => {
  const { ledger, token } = setup(t, { max_tokens_per_run: 40 });
  ledger.reserve(token, 'a', input);
  assert.throws(() => ledger.reserve(token, 'b', { ...input, max_output_tokens: 30 }), /run token limit exceeded/);
});

test('without the limits nothing changes and invalid limits are refused', t => {
  const { ledger, token } = setup(t, {});
  for (let n = 0; n < 3; n += 1) ledger.reserve(token, `k${n}`, input);
  assert.throws(() => ledger.configure(fixturePolicy({ max_calls_per_run: 0 })), /invalid per-run limit/);
  assert.throws(() => ledger.configure(fixturePolicy({ max_calls_per_run: 1.5 })), /invalid per-run limit/);
});
