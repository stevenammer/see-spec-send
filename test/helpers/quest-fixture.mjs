import { STEPS, emptyQuest, answerQuest } from '../../public/vision-quest.js';

export function completedQuest(overrides = {}, person = 'maker') {
  let doc = emptyQuest(person);
  for (const step of STEPS) {
    const fallback = step.options ? step.options.at(-1)[0] : `${step.key}: one reported example`;
    const value = overrides[step.key] ?? ({ have: 'unavailable', pay_for: 'unavailable',
      free: 'unavailable', setting: 'unavailable', playback: 'yes', risk: 'low',
      approach: 'build' }[step.key] || fallback);
    doc = answerQuest(doc, step.key, value, step.options ? 'Author checked this option.' : '');
  }
  return doc;
}
