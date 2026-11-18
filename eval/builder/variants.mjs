// Prompt variants for the builder eval. Each one is carried the way a steward's adopted builder instructions are, so
// a variant is tested through the real path without rebuilding the container image. A variant that wins is a candidate
// for the default prompt in worker/opencode/entrypoint.sh, which is a separate, deliberate change.
const as = text => ({ instruction: text, actor: 'person', source: 'raw-discussion-identity', mode: 'quoted' });

export const variants = {
  base: [],
  'self-check': [as('Before writing code, restate each must-do as a numbered requirement and each way-we-know as a test you will run in your head. After writing the files, re-read every requirement and check the code against it, one at a time, and fix what does not match.')],
  pitfalls: [as('Keep ids, labels and button text exactly as written. Words like newest first, earliest first and sorted mean exactly that, also after a reload. Do money in whole cents and show it with toFixed(2). Compare text ignoring case and spaces only when the spec says to. When the spec says a second click replaces the first result, clear the old result first. Ignore blank input. Save state only when the spec says it must survive a reload, and then restore it when the page loads. Do not add features the spec does not ask for.')],
  both: [
    as('Before writing code, restate each must-do as a numbered requirement and each way-we-know as a test you will run in your head. After writing the files, re-read every requirement and check the code against it, one at a time, and fix what does not match.'),
    as('Keep ids, labels and button text exactly as written. Words like newest first, earliest first and sorted mean exactly that, also after a reload. Do money in whole cents and show it with toFixed(2). Compare text ignoring case and spaces only when the spec says to. When the spec says a second click replaces the first result, clear the old result first. Ignore blank input. Save state only when the spec says it must survive a reload, and then restore it when the page loads. Do not add features the spec does not ask for.'),
  ],
};
