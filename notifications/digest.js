import { canRead, defaultCanRead } from '../access/read.js';

const dayOf = now => new Date(now).toISOString().slice(0, 10);

// Recipients come only from recorded participation and stewardship, never rank.
function recipients(store, annex) {
  const events = store.events(annex.parent.item);
  const context = store.read(annex.parent.item).context;
  const first = events[0];
  return new Set([context.steward, first?.actor,
    ...events.filter(event => ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)).map(event => event.actor)]
    .filter(Boolean));
}

export function deliverAnnexes(store, { now, canRead: policy = defaultCanRead } = {}) {
  if (typeof now !== 'string' || !now) throw new Error('now timestamp required');
  let entries = 0, pinged = 0;
  for (const row of store.knowledge.entries('annex')) {
    if (row.erased) continue;
    for (const person of recipients(store, row.body)) {
      if (!canRead(person, store.readScope(row.body.parent.item), policy)) continue;
      const prior = store.db.prepare('SELECT 1 FROM digest_entries WHERE person=? AND annex_hash=?').get(person, row.hash);
      if (prior) continue;
      const muted = store.db.prepare('SELECT 1 FROM reanalysis_mute WHERE person=?').get(person);
      const day = dayOf(now);
      const alreadyPinged = store.db.prepare('SELECT 1 FROM ping_log WHERE person=? AND day=?').get(person, day);
      const ping = !muted && !alreadyPinged;
      store.db.prepare('INSERT INTO digest_entries(id,person,annex_hash,created_at,seen_at,pinged) VALUES(?,?,?,?,NULL,?)')
        .run(`${person}:${row.hash}`, person, row.hash, now, ping ? 1 : 0);
      if (ping) { store.db.prepare('INSERT INTO ping_log(person,day,annex_hash) VALUES(?,?,?)').run(person, day, row.hash); pinged += 1; }
      entries += 1;
    }
  }
  return { entries, pinged };
}
