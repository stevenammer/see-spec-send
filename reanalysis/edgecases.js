// These are prompts for local human review, not findings about a team.
export const EDGE_CASES = Object.freeze([
  ['night shift', 'Night shift has no export permission. Does this still work?'],
  ['no export permission', 'No export permission. Does this still work?'],
  ['accessibility', 'What accessibility setup needs checking before this is used?'],
  ['language', 'What language needs checking before this is used?'],
  ['low connectivity', 'Low connectivity. Does this still work?'],
  ['temporary staff', 'Temporary staff. Does this still work?'],
  ['remote site', 'Remote site. Does this still work?'],
  ['unusual routing', 'Unusual routing. Does this still work?'],
]);

export function edgeCaseQuestions(description = '') {
  const text = String(description).toLowerCase();
  const matched = EDGE_CASES.filter(([term]) => text.includes(term)).map(([, question]) => question);
  return (matched.length ? matched : EDGE_CASES.slice(0, 2).map(([, question]) => question)).slice(0, 3);
}
