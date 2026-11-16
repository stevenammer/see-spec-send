import { unfence } from '../intelligence/prompt.js';

// Optional advisory review. It can only hold a deterministic match or add
// bounded uncertainty to its separate annex. It never creates a source or target.
const unsafe = /\b(?:weakest(?:\s+links?)?|least\s+(?:effective|productive)|bottom\s+performers?|rank(?:ing)?|score|rate)\b[^.]{0,100}\b(?:people|person|employee|leader|staff|worker)s?\b|\b(?:their|the)\s+motives?\b/i;
const list = value => Array.isArray(value) && value.length <= 5 && value.every(entry => typeof entry === 'string' && entry.length > 0 && entry.length <= 1000);

export async function verifyImpact({ delta, impact, askModel }) {
  if (!delta || !impact || typeof askModel !== 'function') throw Error('verification input required');
  const prompt = Object.freeze({
    task: 'adversarial reanalysis check',
    instructions: 'Decide whether the NEW RESULT bears on the OLD STATEMENTS. Reply with a JSON object with exactly these keys: "material" (true only if the new result changes whether an old statement still holds or matters, false if it merely shares words or is about something else), "bears_on" (an array of old statements copied exactly, empty if none), "known_unknowns" (an array of up to five short strings about what is still unknown), "contrary" (an array of up to five short strings of evidence against a match). Sharing words is not enough: the new result bears on an old statement only if it is about the same thing and changes whether that statement is true, still blocks the work, or changes its cost or feasibility. If the two are about different subjects, material is false. Example: old statement "We cannot approve the vendor because it lacks single sign-on"; a new result "The vendor added single sign-on in version 4" is material, while "The cafeteria vendor lacks a loyalty card" is not. Do not rank people or infer motives. You may only hold this match or add uncertainty.',
    new_result: delta.claims.map(claim => claim.text),
    old_statements: impact.cites.map(cite => cite.quoted),
    why_matched: impact.why_this_case,
    example_reply: { material: false, bears_on: [], known_unknowns: ['Whether the new result applies to the same team.'], contrary: [] },
    // Kept for the audit record; not shown to the model.
    delta_hash: delta.body_hash, target: impact.target,
  });
  const raw = await askModel(prompt);
  if (typeof raw !== 'string' || unsafe.test(raw)) throw Error('unsafe verification output');
  let answer; try { answer = JSON.parse(unfence(raw)); } catch { throw Error('verification JSON required'); }
  if (!answer || Object.keys(answer).sort().join(',') !== 'bears_on,contrary,known_unknowns,material' || typeof answer.material !== 'boolean' || !list(answer.bears_on) || !list(answer.known_unknowns) || !list(answer.contrary)) throw Error('invalid verification answer');
  const cites = new Set(impact.cites.map(cite => cite.quoted));
  if (!answer.bears_on.every(quote => cites.has(quote))) throw Error('verification citation is not in impact');
  return Object.freeze(answer);
}
