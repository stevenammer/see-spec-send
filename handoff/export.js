const erased = (store, event) => store.db.prepare('SELECT erased FROM bodies WHERE hash=?').get(event.body_hash)?.erased === 1;
const safe = (store, event) => !erased(store, event);
const eventFields = event => ({ type: event.type, actor: event.actor, at: event.at, body_hash: event.body_hash });
const filesFor = bytes => {
  try { const value = JSON.parse(bytes); if (value?.sss_bundle === 1 && Array.isArray(value.manifest?.files)) return value.manifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })); } catch {}
  return [{ path: 'artifact', bytes: Buffer.byteLength(bytes || '', 'utf8'), sha256: null }];
};

export function handoffPackage(store, { item, actor }) {
  if (!actor) throw new Error('missing --actor (the person requesting this local export)');
  if (!store.canRead(actor, item)) throw new Error('refused: caller cannot read this item');
  const events = store.events(item), see = events.find(event => ['posted', 'forked'].includes(event.type) && safe(store, event));
  const spec = events.filter(event => event.type === 'specced' && safe(store, event)).at(-1);
  const decision = events.filter(event => ['approved', 'decided', 'returned', 'not_built', 'experiment_not_helpful', 'op_withdrew'].includes(event.type) && safe(store, event)).at(-1);
  if (!see || !spec || !decision) throw new Error('refused: handoff needs an unerased SEE, SPEC, and decision');
  const tried = events.filter(event => event.type === 'tried' && event.spec_hash === spec.body_hash && safe(store, event)).at(-1);
  const build = tried ? { hash: tried.artifact_hash, files: filesFor(store.artifact(item, tried.artifact_hash)), event: eventFields(tried) } : null;
  const comments = events.filter(event => event.type === 'commented' && safe(store, event));
  const receipts = ['gateway_receipts', 'gateway_analysis_receipts', 'gateway_effort_receipts'].flatMap(table => {
    try { return store.db.prepare(`SELECT * FROM ${table} WHERE item=?`).all(item).map(row => ({ table, charged_micros: row.charged_micros, state: row.state, model: row.model || null })); } catch { return []; }
  });
  return { version: 1, shape: 'change-request package for ServiceNow, Jira, or a GitHub issue', item,
    see: { ...eventFields(see), text: see.original || see.problem || null },
    spec: { ...eventFields(spec), must: spec.must || [], how_we_know: spec.how_we_know || [], out_of_scope: spec.out_of_scope || [], assumptions: spec.assumptions || [], open_questions: spec.open_questions || [] },
    decision: { ...eventFields(decision), outcome: decision.disposition || decision.type, reason: decision.reason || null, reason_code: decision.reason_code || null },
    bounded_build_bundle: build, test_and_evidence_summary: { recorded_how_we_know: spec.how_we_know || [], comments: comments.map(event => ({ ...eventFields(event), kind: event.kind, text: event.comment })) },
    cost_ledger: receipts, people_who_decided: [...new Set(events.filter(event => event.type === decision.type && event.body_hash === decision.body_hash).map(event => event.actor))],
    open_risks: [...(spec.assumptions || []), ...(spec.open_questions || [])], erased_text_included: false };
}

export function handoffMarkdown(value) {
  const list = values => values.length ? values.map(entry => `- ${entry}`).join('\n') : '- None recorded';
  return `# Change request: ${value.item}\n\n## SEE\n${value.see.text || 'No readable text.'}\n\n## SPEC\n${list(value.spec.must)}\n\n## Decision\n${value.decision.outcome}: ${value.decision.reason || 'No reason recorded.'}\n\n## Build bundle\n${value.bounded_build_bundle ? `${value.bounded_build_bundle.hash}\n\n${list(value.bounded_build_bundle.files.map(file => `${file.path} (${file.bytes} bytes)`))}` : 'No recorded build bundle.'}\n\n## Evidence\n${list(value.test_and_evidence_summary.recorded_how_we_know)}\n\n## Cost ledger\n${value.cost_ledger.length ? 'Recorded receipts are included in the JSON package.' : 'No item-scoped receipts recorded.'}\n\n## Decision makers\n${list(value.people_who_decided)}\n\n## Open risks\n${list(value.open_risks)}\n`;
}
