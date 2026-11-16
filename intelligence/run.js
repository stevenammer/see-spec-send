import { createHash } from 'node:crypto';
import { refused } from '../core/errors.js';
import { evidencePackage, readAnalysisAnswer } from './evidence.js';
import { completeAnswer, repeatsTemplate } from './prompt.js';

const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
// This catches requests that are still unsafe even when phrased differently from
// the evidence packet's conservative legacy tripwire.
const prohibited = /\bweakest(?:\s+links?)?|least\s+(?:effective|productive)|bottom\s+performers?|rank(?:ing)?\b|score\b|rate\b|infer\s+(?:their\s+)?motives?|why\s+(?:they|someone)\s+(?:wanted|did)|intentionally\b|\bmotives?\b|why\s+did\s+(?:the\s+)?(?:leader|manager|supervisor|director|executive|he|she|they)\b/i;
const unsafeModelOutput = /\b(?:weakest(?:\s+links?)?|least\s+(?:effective|productive)|bottom\s+performers?|rank(?:ing)?|score|rate)\b[^.]{0,100}\b(?:people|person|employee|leader|staff|worker)s?\b|\b(?:their|the)\s+motives?\b/i;
const sourceSet = packet => packet.sources.map(({ item, seq, hash, event_hash }) => ({ item, seq, hash, event_hash }));

function sourcesOnly(packet) {
  return {
    question: packet.request.question, objectives: packet.request.objectives, constraints: packet.request.constraints,
    coverage_notes: ['Sources only. No findings were generated.', ...packet.coverage.missingness.slice(0, 1)],
    findings: packet.sources.map(source => ({
      claim: `Source record ${source.item} sequence ${source.seq} is available for human review; no finding is asserted.`,
      status: 'documented', citations: [{ item: source.item, hash: source.hash }],
      alternatives: ['The record may be incomplete or need context from an authorized person.'],
      uncertainty: ['This deterministic fallback makes no interpretation of the record.'],
      next_investigation: ['A person can review the cited record and add attributed context.'],
    })),
    tradeoffs: ['The no-model path preserves reviewability but does not synthesize a conclusion.'],
    missingness: packet.coverage.missingness,
    correction_path: 'Add attributed context or a correction on a cited work post, then run a fresh analysis.',
  };
}

function reframedPacket(store, viewer, request, options) {
  const safe = { ...request, question: 'What documented criteria, outcomes, and unknowns should be reviewed in these records?' };
  return evidencePackage(store, viewer, safe, options);
}

function refusal(packet, original) {
  return {
    question: packet.request.question, objectives: packet.request.objectives, constraints: packet.request.constraints,
    coverage_notes: ['The original question was reframed. This answer does not compare, score, rank, or attribute motives to people.'],
    findings: packet.sources.map(source => ({
      claim: `Record ${source.item} sequence ${source.seq} is included as an observable source, without a finding about any person.`,
      status: 'documented', citations: [{ item: source.item, hash: source.hash }],
      alternatives: ['Different documented conditions can produce the same outcome.'],
      uncertainty: ['The records do not establish motive, individual ranking, or personnel conclusions.'],
      next_investigation: ['Review agreed criteria, observed outcomes, and missing records with the affected people.'],
    })),
    tradeoffs: ['Criteria-first review can identify process conditions without turning records into a ranking of people.'],
    missingness: ['No motive, intent, or comparative person-performance conclusion is supported.', ...packet.coverage.missingness],
    correction_path: 'Add attributed context or a correction on a cited work post, then run a fresh criteria-first analysis.',
    refusal: 'This request asks for a ranking, score, or motive inference. Review documented criteria, outcomes, and unknowns instead.',
    original_question: original,
  };
}

export async function runAnalysis({ store, viewer, request, askModel = null, now = new Date().toISOString(), clock = Date.now }) {
  const reframe = prohibited.test([request?.question, ...(request?.objectives || [])].join('\n'));
  const packet = reframe ? reframedPacket(store, viewer, request, { clock }) : evidencePackage(store, viewer, request, { clock });
  let checked, configuration;
  if (reframe) {
    checked = { answer: refusal(packet, request.question), label: 'Fixed criteria-first refusal. Human review is still required.' };
    configuration = { mode: 'refused_reframed', provider: 'none' };
  } else if (typeof askModel === 'function') {
    const output = await askModel(Object.freeze(structuredClone(packet)));
    if (unsafeModelOutput.test(output)) throw refused('model output attempted a people ranking or motive inference');
    try {
      checked = readAnalysisAnswer(packet, completeAnswer(packet, output));
      if (repeatsTemplate(packet, checked.answer)) throw refused('answer repeats the template text instead of findings');
      configuration = { mode: 'model', provider: 'gateway analysis', job_class: 'analysis' };
    } catch (error) {
      // A malformed or hollow model answer never becomes a finding. The person still gets the sources, and is told why.
      checked = { answer: sourcesOnly(packet), label: `The model's answer was refused (${String(error.message).slice(0, 120)}). Sources-only answer shown; human review is required.` };
      configuration = { mode: 'model_refused_sources_only', provider: 'gateway analysis', job_class: 'analysis' };
    }
  } else {
    checked = { answer: sourcesOnly(packet), label: 'Sources-only deterministic answer. No finding was generated; human review is required.' };
    configuration = { mode: 'sources_only', provider: 'none' };
  }
  const body = Object.freeze({ version: 1, question: request.question, criteria: { objectives: request.objectives, constraints: request.constraints },
    package_hash: packet.hash, source_set_hash: sha(sourceSet(packet)), sources: sourceSet(packet), omissions: packet.coverage.missingness,
    model_configuration: configuration, answer: checked.answer, label: checked.label, created_at: now, reframed: reframe });
  const receipt = store.knowledge.append('analysis_receipt', body, { at: now });
  return { receipt: { ...receipt, ...body }, packet: reframe ? undefined : packet };
}

export function readAnalysisReceipt(store, viewer, hash) {
  const entry = store.knowledge.entries('analysis_receipt').find(row => row.hash === hash);
  if (!entry) throw refused('analysis receipt unavailable');
  if (!entry.body.sources.every(source => store.canRead(viewer, source.item))) {
    return { scope: 'differs', message: 'Your current read scope differs. Restricted sources and the answer are not shown.' };
  }
  return { scope: 'same', receipt: entry.body, hash: entry.hash };
}

export function challengeAnalysisReceipt(store, viewer, hash, text, now = new Date().toISOString()) {
  const visible = readAnalysisReceipt(store, viewer, hash);
  if (visible.scope !== 'same') throw refused('analysis receipt is outside your current read scope');
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw refused('challenge text required');
  return store.knowledge.append('analysis_challenge', { receipt_hash: hash, person: viewer, text: text.trim(), created_at: now }, { at: now });
}
