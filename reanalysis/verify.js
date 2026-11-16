// Optional advisory review. It can only hold a deterministic match or add
// bounded uncertainty to its separate annex. It never creates a source or target.
const unsafe = /\b(?:weakest(?:\s+links?)?|least\s+(?:effective|productive)|bottom\s+performers?|rank(?:ing)?|score|rate)\b[^.]{0,100}\b(?:people|person|employee|leader|staff|worker)s?\b|\b(?:their|the)\s+motives?\b/i;
const list = value => Array.isArray(value) && value.length <= 5 && value.every(entry => typeof entry === 'string' && entry.length > 0 && entry.length <= 1000);

export async function verifyImpact({ delta, impact, askModel }) {
  if (!delta || !impact || typeof askModel !== 'function') throw Error('verification input required');
  const prompt = Object.freeze({
    task: 'adversarial reanalysis check',
    rules: ['Return JSON only.', 'Do not rank people or infer motives.', 'You may only hold this match or add uncertainty.'],
    delta: { hash: delta.body_hash, claims: delta.claims.map(claim => claim.text) },
    impact: { target: impact.target, cites: impact.cites.map(cite => cite.quoted), why_matched: impact.why_this_case },
    answer: { material: 'boolean', bears_on: 'exact cite quotes only', known_unknowns: 'up to five strings', contrary: 'up to five strings' },
  });
  const raw = await askModel(prompt);
  if (typeof raw !== 'string' || unsafe.test(raw)) throw Error('unsafe verification output');
  let answer; try { answer = JSON.parse(raw); } catch { throw Error('verification JSON required'); }
  if (!answer || Object.keys(answer).sort().join(',') !== 'bears_on,contrary,known_unknowns,material' || typeof answer.material !== 'boolean' || !list(answer.bears_on) || !list(answer.known_unknowns) || !list(answer.contrary)) throw Error('invalid verification answer');
  const cites = new Set(impact.cites.map(cite => cite.quoted));
  if (!answer.bears_on.every(quote => cites.has(quote))) throw Error('verification citation is not in impact');
  return Object.freeze(answer);
}
