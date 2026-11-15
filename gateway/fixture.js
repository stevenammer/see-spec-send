// Synthetic accounting proof only. No network, secrets, SDK, model or provider invoice.
export async function fixtureProvider(request) {
  if (request.model !== 'fixture:text-v1') throw new Error('fixture model required');
  let task; try { task = JSON.parse(request.input).task; } catch { /* generic fixture request */ }
  const output = task === 'spec_prepare' ? JSON.stringify({
    must: ['Fixture draft: try a small handoff improvement using synthetic data.'],
    how_we_know: ['Have an independent person test the handoff and record what changed.'],
    out_of_scope: ['Real customer data and production changes.'],
    assumptions: ['Synthetic fixture only; no model has investigated this proposal.'],
    open_questions: ['Can an existing tool or process solve this without building?'],
  }) : 'Fixture result';
  return { output, usage: {
    input_tokens: Buffer.byteLength(request.input) + 8, output_tokens: 1,
  } };
}
