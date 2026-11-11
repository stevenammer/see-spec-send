// Optional drafting is deliberately a small client of the existing gateway boundary.
const rate = Object.freeze({ input_micros: 1, output_micros: 2, framing_tokens: 8 });
export function preflightDraft({ item, spec_hash, prompt, max_output_tokens }) {
  if (!item || !spec_hash || typeof prompt !== 'string' || !Number.isInteger(max_output_tokens) || max_output_tokens < 1)
    throw Error('draft packet refused');
  const inputTokens = Buffer.byteLength(prompt) + rate.framing_tokens;
  const worst_case_micros = inputTokens * rate.input_micros + max_output_tokens * rate.output_micros;
  return Object.freeze({ model: 'fixture:text-v1', input: prompt, max_output_tokens, item, spec_hash,
    input_tokens_bound: inputTokens, worst_case_micros, label: 'Model output, review required. It cannot approve or change state.' });
}
export async function sendDraft(gateway, capability, packet, approved) {
  if (approved !== true) throw Error('explicit approval required');
  const result = await gateway.call(capability, `draft:${packet.item}:${packet.spec_hash}`, {
    model: packet.model, input: packet.input, max_output_tokens: packet.max_output_tokens,
  });
  return { ...result, label: packet.label };
}
