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

// Deterministic OpenAI-shaped fake. It is the only chat upstream used in tests.
export const fixtureChatProvider = Object.freeze({
  async chat(request) {
    const tool = request.tools?.[0];
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: tool.function.name, arguments: '{"fixture":true}' } }] }
      : { role: 'assistant', content: 'Fixture chat result' };
    const usage = { input_tokens: Buffer.byteLength(JSON.stringify(request.messages)), output_tokens: 1 };
    if (!request.stream) return { id: 'chatcmpl-fixture', object: 'chat.completion', model: request.model, choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage };
    return (async function* () {
      yield { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: tool ? { tool_calls: message.tool_calls } : { content: 'Fixture chat result' }, finish_reason: null }] };
      yield { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage };
    })();
  },
});
