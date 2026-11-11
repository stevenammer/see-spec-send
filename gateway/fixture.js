// Synthetic accounting proof only. No network, secrets, SDK, model or provider invoice.
export async function fixtureProvider(request) {
  if (request.model !== 'fixture:text-v1') throw new Error('fixture model required');
  return { output: 'Fixture result', usage: {
    input_tokens: Buffer.byteLength(request.input) + 8, output_tokens: 1,
  } };
}
