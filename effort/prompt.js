const SYSTEM = 'You are Effort, an AI thinking partner in See / Spec / Send. Reply with one useful, plain-language comment. You cannot approve, change a post, spend money, or create events.';

export function effortPrompt(original, events) {
  return Object.freeze({ system: SYSTEM, input: JSON.stringify({ original, thread: events }) });
}
