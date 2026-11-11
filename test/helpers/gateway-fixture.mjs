import { Store } from '../../core/store.js';
import { Worker } from '../../worker/runner.js';
import { FakeAdapter } from '../../worker/fake.js';
import { Ledger, fixturePolicy } from '../../gateway/ledger.js';

export const put = (store, type, actor, body = {}, item = 'item') => store.append(item,
  { type, actor, at: new Date().toISOString(), ...body }, { idem: `${type}:${store.events(item).length}` });
export const spec = store => put(store, 'specced', 'writer', {
  must: ['One local proof'], how_we_know: ['A visible result'], out_of_scope: ['External calls'],
});
export const approve = (store, cap = 0.1) => put(store, 'approved', 'leader', {
  spec_hash: store.read('item').context.specHash, cap_usd: cap, quorum: 2,
});
class Waiting extends FakeAdapter { status() { return { state: 'running' }; } }
export function fixture(file = ':memory:', policy = {}, cap = 0.1, options = {}) {
  const store = new Store(file);
  store.registerPerson('writer');
  store.registerPerson('leader', { leader: true });
  put(store, 'checked', 'writer', { problem: 'Synthetic proof', looked: ['Existing options'],
    found: [], verdict: 'build_needed' });
  spec(store);
  approve(store, cap);
  new Worker(store, new Waiting(store)).reconcile();
  const run = store.db.prepare('SELECT * FROM runs WHERE item=?').get('item');
  const ledger = new Ledger(store, options);
  ledger.configure(fixturePolicy(policy));
  const token = ledger.mint(run.id);
  return { store, ledger, token, run };
}
export const request = (changes = {}) => ({ model: 'fixture:text-v1', input: 'hello', max_output_tokens: 10, ...changes });
export const usage = (input = request()) => ({ output: 'result', usage: {
  input_tokens: Buffer.byteLength(input.input) + 8, output_tokens: 1,
} });
