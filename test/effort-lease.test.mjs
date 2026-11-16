import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { EffortGateway, effortAllowance } from '../gateway/effort.js';
import { EffortWorker, UNKNOWN_PROVIDER_STATUS } from '../app/effort.js';
import { renderEffortStatus } from '../app/pages-effort.js';

test('concurrent workers and expired leases share one dispatch and fence stale completion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-effort-lease-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = new Store(join(dir, 'db')); const b = new Store(join(dir, 'db')); t.after(() => { a.close(); b.close(); });
  a.registerPerson('op'); a.append('item', { type: 'posted', actor: 'op', original: 'A handoff loses context.', rules: 2, at: new Date().toISOString() }, { idem: 'seed' });
  let clock = Date.now(); const ledgerA = new Ledger(a, { clock: () => clock }); ledgerA.configure(fixturePolicy());
  const ledgerB = new Ledger(b, { clock: () => clock });
  let release, calls = 0;
  const provider = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { output: 'Review the handoff.', usage: { input_tokens: 4, output_tokens: 1 } }; };
  const gatewayA = new EffortGateway(ledgerA, provider, { clock: () => clock });
  const gatewayB = new EffortGateway(ledgerB, provider, { clock: () => clock });
  const one = new EffortWorker(a, gatewayA, { clock: () => clock }); const two = new EffortWorker(b, gatewayB, { clock: () => clock });
  const pending = one.tick();
  assert.equal(await one.tick(), false); assert.equal(await two.tick(), false); assert.equal(calls, 1);
  clock += 8000;
  assert.equal(await two.tick(), false); assert.equal(calls, 1);
  const waiting = a.db.prepare('SELECT * FROM effort_jobs').get();
  assert.equal(waiting.last_error, UNKNOWN_PROVIDER_STATUS);
  assert.match(renderEffortStatus([waiting]), /charged hold retained; awaiting reconciliation/);
  assert.doesNotMatch(renderEffortStatus([waiting]), /thinking|retrying/);
  // Simulate independently reconciled usage while the old provider promise
  // is still alive; the old owner must not regress a completed job.
  const receipt = gatewayB.receipts()[0];
  gatewayB.update(receipt, { state: 'settled', charged_micros: 6,
    usage: JSON.stringify({ input_tokens: 4, output_tokens: 1 }), outcome: JSON.stringify({ output: 'Review the handoff.' }) });
  clock += 8000;
  assert.equal(await two.tick(), true);
  release(); assert.equal(await pending, false, 'expired owner cannot append or regress done');
  assert.equal(calls, 1); assert.equal(gatewayA.receipts().length, 1);
  assert.equal(a.events('item').filter(event => event.type === 'commented').length, 1);
  assert.equal(a.db.prepare('SELECT state,attempts FROM effort_jobs').get().state, 'done');
  assert.equal(a.db.prepare('SELECT attempts FROM effort_jobs').get().attempts, 1);
  assert.equal(effortAllowance(a, 'op', 'item', () => clock).automatic_item, 1);
});

test('settled receipt recovers exactly once after call-append crash', async () => {
  const store = new Store(); try {
    store.registerPerson('op'); store.append('item', { type: 'posted', actor: 'op', original: 'A handoff loses context.', rules: 2, at: new Date().toISOString() }, { idem: 'seed' });
    const ledger = new Ledger(store); ledger.configure(fixturePolicy()); let calls = 0;
    const worker = new EffortWorker(store, new EffortGateway(ledger, async () => { calls++; return { output: 'Review.', usage: { input_tokens: 4, output_tokens: 1 } }; }));
    await worker.tick({ crashAfterCall: true }); await worker.tick(); await worker.tick();
    assert.equal(calls, 1); assert.equal(store.events('item').filter(event => event.type === 'commented').length, 1);
  } finally { store.close(); }
});
