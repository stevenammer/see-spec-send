import { edgeCaseQuestions } from './edgecases.js';

const overlap = (tags, description) => tags.some(tag => String(description).toLowerCase().includes(tag));
const dismissed = (store, item, group) => store.knowledge.entries('edge').some(row => row.body.item === item && row.body.group === group && row.body.status === 'dismissed');

// Only descriptions and catalog tags participate in matching. Source prose is never
// placed in another department's candidate card or model prompt.
export function propagateOpportunities(store, { at }) {
  const edges = [];
  for (const capability of store.knowledge.entries('capability')) {
    const body = capability.body;
    for (const group of store.groups()) {
      if (dismissed(store, body.item, group.name) || !overlap(body.tags || [], group.description)) continue;
      const owner = [...group.members].sort()[0] || null;
      if (!owner) continue;
      const sourceScope = body.item && store.readScope(body.item);
      const visible = !sourceScope || store.canRead(owner, body.item);
      const edge = { v: 1, status: 'candidate', item: body.item, capability: capability.hash, group: group.name, owner,
        summary: visible ? body.summary.slice(0, 240) : 'A restricted related case exists. Ask its steward for details.',
        contact: sourceScope?.steward || null, restricted: visible ? false : true,
        questions: edgeCaseQuestions(group.description) };
      const entry = store.knowledge.append('edge', edge, { at });
      if (!entry.duplicate) edges.push({ ...edge, hash: entry.hash });
    }
  }
  return edges;
}

export function resolveEdge(store, hash, status, { at }) {
  if (!['confirmed', 'contradicted', 'dismissed'].includes(status)) throw new Error('invalid edge status');
  const source = store.knowledge.entries('edge').find(row => row.hash === hash);
  if (!source) throw new Error('unknown edge');
  return store.knowledge.append('edge', { ...source.body, status, supersedes: hash }, { at });
}
