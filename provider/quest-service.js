import { preflightQuestModel, importPortableMemo } from './vision-quest.js';

// The HTTP app knows no provider credentials. This adapter is only constructed
// by `serve --enable-quest-model` after the metered gateway is configured.
export function questModelService(gateway, providerName, env = process.env) {
  return Object.freeze({
    preflight(input) {
      return preflightQuestModel({ providerName, org: input.org || 'default', doc: input.quest,
        maxOutputTokens: input.max_output_tokens || 1 }, env);
    },
    async draft(person, input, idem) {
      const packet = this.preflight(input);
      const result = await gateway.call(person, idem, {
        model: packet.model, input: packet.input, max_output_tokens: packet.max_output_tokens,
      });
      if (result.status !== 200) return result.body;
      return { packet, result: importPortableMemo(result.body.output, input.quest) };
    },
  });
}
