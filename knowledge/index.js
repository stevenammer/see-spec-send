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
  const rows = [];
  for (const { item } of store.db.prepare('SELECT item FROM items ORDER BY item').all()) {
    if (!canRead(viewer, store.readScope(item), policy)) continue;
    for (const event of store.events(item)) {
      const erased = store.db.prepare('SELECT erased FROM bodies WHERE hash=?').get(event.body_hash)?.erased === 1;
      if (erased) continue;
      for (const entry of typed(event)) if (!needle || entry.text.toLowerCase().includes(needle)) rows.push({ item, hash: event.body_hash, at: event.at, ...entry });
    }
  }
  return rows;
}
