import { canonical } from './chain.js';
import { createHash } from 'node:crypto';

const terms = text => [...new Set(String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [])].filter(word => word.length > 2).slice(0, 12);
const idFor = value => createHash('sha256').update(canonical(value)).digest('hex');

// Catalog entries are separate derived records. They never alter the frozen item.
export function catalogCapabilities(store, { at }) {
  const made = [];
  for (const { item } of store.db.prepare('SELECT DISTINCT item FROM events ORDER BY item').all()) {
    for (const event of store.events(item)) {
      const alternative = event.type === 'decided' && event.disposition === 'resolve_without_build' ? event.metadata?.alternative : null;
      if (event.type !== 'helped' && typeof alternative !== 'string') continue;
      const source = event.type === 'helped' ? store.events(item).find(entry => entry.type === 'specced') : event;
      const summary = alternative || source?.must?.join(' ') || 'Recorded HELPS result';
      const body = { v: 1, status: 'candidate', item, source_hash: event.body_hash, summary, tags: terms(summary) };
      const entry = store.knowledge.append('capability', body, { at });
      if (!entry.duplicate) {
        const id = idFor(body);
        store.db.prepare('INSERT OR IGNORE INTO capability_catalog(id,tags,summary,source_item,source_hash,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, JSON.stringify(body.tags), summary, item, event.body_hash, at);
        made.push({ id, ...body, hash: entry.hash });
      }
    }
  }
  return made;
}

export function addCapability(store, { summary, tags = [], item = null, source_hash = null, at }) {
  if (typeof summary !== 'string' || !summary || !Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) throw new Error('valid capability required');
  const body = { v: 1, status: 'candidate', item, source_hash, summary, tags: [...new Set(tags)].sort() };
  const entry = store.knowledge.append('capability', body, { at }); const id = idFor(body);
  store.db.prepare('INSERT OR IGNORE INTO capability_catalog(id,tags,summary,source_item,source_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, JSON.stringify(body.tags), summary, item, source_hash, at);
  return { id, ...entry, body };
}
