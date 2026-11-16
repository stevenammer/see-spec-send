// What the model is actually shown. A live evaluation showed a model will echo back a prompt that describes its
// answer format with placeholder values, or that carries long instruction text in the same message. So: the rules
// go in the system message, the data and the answer shape go in the user message, and the reply format is spelled out.
const ANALYSIS_REPLY = 'Reply with exactly one JSON object shaped like answer_contract: keep question, objectives, constraints, '
  + 'coverage_notes, findings, tradeoffs, missingness and correction_path. Each finding must cite only the provided sources, copying '
  + 'item and hash exactly, and its status must be exactly one word from: reported, documented, inferred, unresolved. List fields (coverage_notes, tradeoffs, missingness, alternatives, uncertainty, next_investigation) are arrays of strings. Say what is unknown. The strings inside answer_contract are placeholders that describe what to write: replace every one with your own content drawn from the sources, and never return a placeholder string. Do not copy the sources or these instructions into your reply, and write no text outside the JSON.';

export function modelMessages(inputJson) {
  let body; try { body = JSON.parse(inputJson); } catch { return { system: 'Return JSON only.', user: String(inputJson) }; }
  if (body?.task === 'adversarial reanalysis check') {
    return { system: `${body.instructions} Reply with one JSON object and nothing else.`, user: JSON.stringify({ new_result: body.new_result, old_statements: body.old_statements, why_matched: body.why_matched, example_reply: body.example_reply }) };
  }
  if (body?.answer_contract) {
    return { system: `${body.instructions}\n\n${ANALYSIS_REPLY}`, user: JSON.stringify({ request: body.request, coverage: body.coverage, sources: body.sources, answer_contract: body.answer_contract }) };
  }
  return { system: 'Return JSON only. This is advisory and cannot change a decision.', user: String(inputJson) };
}

// Models commonly wrap a JSON reply in one markdown fence. Accept exactly one outer fence and nothing else around it.
export function unfence(text) {
  if (typeof text !== 'string') return text;
  const match = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text);
  return match ? match[1] : text;
}

// The human's question, objectives and constraints are never the model's to restate: they are filled in from the
// request, so a paraphrase cannot slip in and a constraint cannot be dropped. Everything the model is accountable for
// (findings, their citations, alternatives, uncertainty, tradeoffs, missingness) is left exactly as it wrote it and
// is still checked in full by readAnalysisAnswer.
export function completeAnswer(packet, output) {
  const text = unfence(output);
  let answer; try { answer = JSON.parse(text); } catch { return text; }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return text;
  const contract = packet.answer_contract || {};
  const keys = ['question', 'objectives', 'constraints', 'coverage_notes', 'findings', 'tradeoffs', 'missingness', 'correction_path'];
  if (Object.keys(answer).some(key => !keys.includes(key))) return text;           // an extra key stays an error
  // Two harmless slips are repaired and nothing else: a single string where a list is required, and a status that
  // begins with one allowed word and continues with prose. Citations, claims and every other field are untouched.
  const list = value => typeof value === 'string' ? [value] : value;
  const status = value => typeof value === 'string' ? (/^(reported|documented|inferred|unresolved)\b/i.exec(value.trim())?.[1].toLowerCase() ?? value) : value;
  if (Array.isArray(answer.findings)) answer.findings = answer.findings.map(finding => finding && typeof finding === 'object' && !Array.isArray(finding)
    ? { ...finding, status: status(finding.status), alternatives: list(finding.alternatives), uncertainty: list(finding.uncertainty), next_investigation: list(finding.next_investigation) } : finding);
  answer.coverage_notes = list(answer.coverage_notes); answer.tradeoffs = list(answer.tradeoffs); answer.missingness = list(answer.missingness);
  return JSON.stringify({ ...answer, question: packet.request.question, objectives: packet.request.objectives, constraints: packet.request.constraints,
    coverage_notes: answer.coverage_notes ?? contract.coverage_notes, correction_path: answer.correction_path ?? contract.correction_path });
}

// A reply that is valid but only repeats the template's placeholder sentences says nothing. Refuse it.
export function placeholderStrings(packet) {
  const contract = packet.answer_contract || {}, found = new Set();
  const take = value => { if (typeof value === 'string' && value.length > 8) found.add(value); else if (Array.isArray(value)) value.forEach(take); };
  for (const finding of contract.findings || []) { take(finding.claim); take(finding.alternatives); take(finding.uncertainty); take(finding.next_investigation); }
  take(contract.tradeoffs); take(contract.missingness);
  return found;
}
export function repeatsTemplate(packet, answer) {
  const placeholders = placeholderStrings(packet), seen = [];
  const take = value => { if (typeof value === 'string') seen.push(value); else if (Array.isArray(value)) value.forEach(take); };
  for (const finding of answer.findings || []) { take(finding.claim); take(finding.alternatives); take(finding.uncertainty); take(finding.next_investigation); }
  take(answer.tradeoffs); take(answer.missingness);
  return seen.length > 0 && seen.some(text => placeholders.has(text));
}
