// What a person is told when the metered gateway refuses a call. The gateway's own reason strings stay as they are
// (they are matched by tests and by the Effort worker); this maps each to one plain sentence.
const RESETS = 'It starts over at midnight UTC.';
export const BUDGET_SENTENCES = Object.freeze([
  [/^day cap exceeded$/, `Today's AI budget is used up. ${RESETS}`],
  [/^global cap exceeded$/, 'The AI budget for this site is used up. An administrator has to raise it before AI works again.'],
  [/daily call limit$|item call limit$/, `You've used all of your AI calls for today. ${RESETS}`],
  [/daily budget exceeded$/, `You've used your share of the AI budget for today. ${RESETS}`],
  [/^(gateway disabled|stopped run)$/, 'AI is switched off right now.'],
]);
export const budgetSentence = message => {
  const text = String(message ?? '');
  return BUDGET_SENTENCES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
};
