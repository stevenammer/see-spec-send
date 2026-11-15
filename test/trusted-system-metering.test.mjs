import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Ledger, fixturePolicy, fixtureRates, rateWithSystemText } from '../gateway/ledger.js';
import { providerGateway } from '../gateway/http.js';
import { QuestGateway } from '../gateway/quest.js';
import { EffortGateway } from '../gateway/effort.js';
import { SYSTEM_PROMPT } from '../worker/builder/index.js';
import { EFFORT_SYSTEM } from '../effort/prompt.js';
import { SPEC_INSTRUCTIONS } from '../effort/spec.js';
import { QUEST_SYSTEM } from '../provider/vision-quest.js';
import { fixture, request } from './helpers/gateway-fixture.mjs';

const input = request({ input: '{}', max_output_tokens: 1 });
const providerResult = n => ({ output: 'ok', usage: { input_tokens: n, output_tokens: 1 } });

test('builder reserves trusted system bytes before dispatch and snapshots its rate', async () => {
  const { store, ledger, token } = fixture();
  try {
    const n = Buffer.byteLength(input.input) + Buffer.byteLength(SYSTEM_PROMPT);
    const gateway = providerGateway(ledger, { complete: async () => ({ text: 'ok', usage: { inputTokens: n, outputTokens: 1 } }) }, { system: SYSTEM_PROMPT });
    assert.equal((await gateway.call(token, 'builder-system', input)).status, 200);
    const row = ledger.receipts()[0];
    assert.equal(row.input_bound, n + fixtureRates.framing_tokens);
    assert.equal(JSON.parse(row.rate).framing_tokens, Buffer.byteLength(SYSTEM_PROMPT) + fixtureRates.framing_tokens);
    assert.equal(row.charged_micros, n + 2);
    assert.equal(ledger.rate.framing_tokens, fixtureRates.framing_tokens);
  } finally { store.close(); }
});

test('Effort and Quest system usage settles and failure holds the full adjusted reservation', async () => {
  for (const [kind, systems] of [['quest', [QUEST_SYSTEM]], ['effort', [EFFORT_SYSTEM, SPEC_INSTRUCTIONS]]]) {
    const store = new Store();
    try {
      const rate = rateWithSystemText(fixtureRates, ...systems);
      const ledger = new Ledger(store, { rate }); ledger.configure(fixturePolicy());
      const n = Buffer.byteLength(input.input) + Math.max(...systems.map(s => Buffer.byteLength(s)));
      const make = provider => kind === 'quest' ? new QuestGateway(ledger, provider) : new EffortGateway(ledger, provider);
      const call = (gateway, idem) => kind === 'quest' ? gateway.call('person', idem, input) : gateway.call('person', idem, input, 'item', 'job');
      const gateway = make(async () => providerResult(n));
      assert.equal((await call(gateway, 'settled')).status, 200);
      assert.equal(gateway.receipts()[0].charged_micros, n + 2);
      const failure = make(async () => { throw Error('unknown provider usage'); });
      assert.equal((await call(failure, 'hold')).status, 202);
      const hold = failure.receipts().find(row => row.state === 'dispatched');
      assert.equal(hold.input_bound, n + fixtureRates.framing_tokens);
      assert.equal(hold.charged_micros, hold.worst_micros);
      ledger.setPolicy(fixturePolicy({ global_micros: hold.charged_micros, day_micros: 100000 }));
      let calls = 0;
      await assert.rejects(call(make(async () => { calls++; return providerResult(n); }), 'cap'), /global cap exceeded/);
      assert.equal(calls, 0);
    } finally { store.close(); }
  }
});

test('empty systems preserve fixture bounds and invalid or overflowing adjustments fail', () => {
  assert.deepEqual(rateWithSystemText(fixtureRates, ''), fixtureRates);
  assert.throws(() => rateWithSystemText(fixtureRates, null), /invalid trusted system/);
  assert.throws(() => rateWithSystemText({ ...fixtureRates, framing_tokens: Number.MAX_SAFE_INTEGER }, 'x'), /unsafe accounting/);
});
