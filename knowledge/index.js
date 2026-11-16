import { canRead, defaultCanRead } from '../access/read.js';

const typed = event => {
  if (event.type === 'decided') return [{ type: 'decision', text: event.reason || '' }];
  if (event.type === 'specced') return [
    ...(event.assumptions || []).map(text => ({ type: 'assumption', text })),
    ...(event.open_questions || []).map(text => ({ type: 'question', text })),
  ];
  if (event.type === 'researched') return Object.entries(event.sources || {}).map(([source_name, source]) => ({ type: source.status === 'not connected' ? 'research' : 'result', source_name, text: source.finding || '', connected: source.status !== 'not connected' }));
  return [];
};

// Retrieval is scoped before source text is returned. This index is a view of
// recorded human/system events, not a semantic summary or a people ranking.
export function searchKnowledge(store, viewer, query = '', { canRead: policy = defaultCanRead } = {}) {
  const needle = String(query).trim().toLowerCase();
  const rows = [], allowed = new Map();
  // Only the three event types the index understands are read, in one query, with erasure checked in the same row.
  const events = store.db.prepare(`SELECT e.item, e.type, e.actor, e.body_hash, e.at, b.bytes FROM events e JOIN bodies b ON b.hash = e.body_hash
    WHERE e.type IN ('decided', 'specced', 'researched') AND COALESCE(b.erased, 0) = 0 ORDER BY e.item, e.seq`).all();
  for (const row of events) {
    if (!allowed.has(row.item)) allowed.set(row.item, canRead(viewer, store.readScope(row.item), policy));
    if (!allowed.get(row.item)) continue;
    const event = { ...JSON.parse(row.bytes), type: row.type, actor: row.actor, body_hash: row.body_hash, at: row.at };
    for (const entry of typed(event)) if (!needle || entry.text.toLowerCase().includes(needle)) rows.push({ item: row.item, hash: event.body_hash, at: event.at, ...entry });
  }
  return rows;
}
