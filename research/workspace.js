// Optional in-workspace research. No external search, model, or network call.
export function workspaceRecords(store, person, item, text) {
  if (store.db.prepare("SELECT enabled FROM research_config WHERE source='this_workspace'").get()?.enabled !== 1) return [];
  const query = String(text || '').match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 4).join(' ') || '';
  return store.search(person, query, { limit: 6 }).filter(row => row.item !== item).slice(0, 5);
}
export function workspaceConnectors(store, person) {
  if (store.db.prepare("SELECT enabled FROM research_config WHERE source='this_workspace'").get()?.enabled !== 1) return {};
  return { 'internal prior work': input => {
    const query = String(input?.text || '').match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 4).join(' ') || '';
    const matches = workspaceRecords(store, person, input.item, input.text);
    const coverage = `Checked enabled workspace records for the literal words: ${query || '(no words)'}. No external sources checked.`;
    return matches.length ? `${coverage}\n${matches.map(row => `Source ${row.item} event ${row.seq}, hash ${row.hash}, ${row.kind} by ${row.author}: ${row.text.slice(0, 120)}`).join('\n')}`.slice(0, 2000)
      : `${coverage}\nNo matching prior workspace records found.`;
  } };
}
