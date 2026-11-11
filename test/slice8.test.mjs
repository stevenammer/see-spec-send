import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightDraft, sendDraft } from '../drafting/preflight.js';
test('draft preflight is exact, fixture-only, labeled, and never sends without explicit approval', async () => {
  const packet = preflightDraft({ item: 'synthetic-item', spec_hash: 'a'.repeat(64), prompt: 'Synthetic draft', max_output_tokens: 12 });
  assert.equal(packet.model, 'fixture:text-v1'); assert.equal(packet.worst_case_micros, Buffer.byteLength('Synthetic draft') + 8 + 24);
  let calls = 0; const gateway = { call: async (_cap, _key, request) => { calls += 1; return { status: 200, body: { output: `Fixture: ${request.input}` } }; } };
  await assert.rejects(sendDraft(gateway, 'synthetic-capability', packet, false), /explicit approval/); assert.equal(calls, 0);
  const result = await sendDraft(gateway, 'synthetic-capability', packet, true);
  assert.equal(calls, 1); assert.match(result.label, /Model output/); assert.match(result.label, /cannot approve/);
});
