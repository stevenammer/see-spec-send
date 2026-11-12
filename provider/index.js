// The provider boundary is deliberately small. Adapters return text, never an
// authority decision, event, or command.
import assert from 'node:assert/strict';

export function validateCompletion(value) {
  if (!value || typeof value.text !== 'string' || !value.usage ||
      !Number.isSafeInteger(value.usage.inputTokens) || value.usage.inputTokens < 0 ||
      !Number.isSafeInteger(value.usage.outputTokens) || value.usage.outputTokens < 0) {
    throw Error('invalid provider completion');
  }
  return value;
}

// Exported so an organization can run the exact contract checks against its own
// adapter without importing the gateway or a database.
export async function providerConformance(makeProvider) {
  assert.equal(typeof makeProvider, 'function', 'provider factory required');
  const controller = new AbortController();
  const provider = makeProvider();
  assert.equal(typeof provider?.complete, 'function', 'complete function required');
  const result = await provider.complete({ system: 'System', messages: [{ role: 'user', content: 'Hello' }],
    maxOutputTokens: 7, model: 'test-model', signal: controller.signal });
  validateCompletion(result);
  return true;
}

export function asGatewayProvider(provider, { system = '' } = {}) {
  if (!provider || typeof provider.complete !== 'function') throw Error('provider complete function required');
  return async input => {
    const result = validateCompletion(await provider.complete({ system,
      messages: [{ role: 'user', content: input.input }], maxOutputTokens: input.max_output_tokens,
      model: input.model, signal: AbortSignal.timeout(60_000) }));
    return { output: result.text, usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens } };
  };
}
