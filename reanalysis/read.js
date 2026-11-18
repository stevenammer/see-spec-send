import { audienceCovers } from '../access/read.js';

// An update is written only when everyone who could read its target case could also read the case it quotes. Groups
// change afterwards, so the same test runs again whenever an update is read. An update whose source can't be found
// is hidden, not shown.
export function annexVisible(store, annex, sources = deltaSources(store)) {
  const source = sources.get(annex.body?.delta);
  const target = annex.body?.parent?.item;
  return Boolean(source && target && audienceCovers(store.readScope(source), store.readScope(target)));
}

export function deltaSources(store) {
  return new Map(store.knowledge.entries('delta').map(row => [row.body_hash, row.body?.source?.item]));
}

export function currentAnnexes(store, item) {
  const sources = deltaSources(store);
  return store.knowledge.entries('annex').filter(row => row.body.parent?.item === item && annexVisible(store, row, sources));
}
