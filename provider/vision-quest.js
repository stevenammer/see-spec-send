import { preflightConfiguredDraft } from '../drafting/preflight.js';
import { providerFor } from './config.js';
import { validateCompletion } from './index.js';
import { validateQuest, portableQuestPrompt, importPortableMemo, QUEST_MODEL_LABEL } from '../public/vision-quest.js';

export { portableQuestPrompt, importPortableMemo, QUEST_MODEL_LABEL };

export function preflightQuestModel({ providerName, org = 'default', doc, maxOutputTokens = 800 }, env = process.env) {
  validateQuest(doc);
  const prompt = portableQuestPrompt(doc);
  return preflightConfiguredDraft({ providerName, item: `quest:${org}:${doc.questId || 'draft'}`,
    spec_hash: 'vision-quest', prompt, max_output_tokens: maxOutputTokens }, env);
}

export async function draftQuestModel({ providerName, doc, approved = false, maxOutputTokens = 800 }, env = process.env) {
  if (approved !== true) throw Error('explicit approval required');
  const packet = preflightQuestModel({ providerName, doc, maxOutputTokens }, env);
  const result = validateCompletion(await providerFor(providerName, env).complete({
    system: 'Draft only. Never decide or claim verification. Return JSON only.',
    messages: [{ role: 'user', content: packet.input }], maxOutputTokens: packet.max_output_tokens,
    model: packet.model, signal: AbortSignal.timeout(30_000),
  }));
  return { packet, result: importPortableMemo(result.text, doc), usage: result.usage };
}
