import { createHash } from 'node:crypto';

const statuses = {
  assumption: new Set(['unverified', 'observed', 'reported', 'contradicted']),
  question: new Set(['open', 'answered']),
};
const idFor = (item, kind, text) => `ledger:${createHash('sha256').update(`${item}\0${kind}\0${text}`).digest('hex').slice(0, 24)}`;

// The event is the authority. This projection is deliberately disposable.
export function normalizeLedger(item, event, prior = []) {
  if (event.ledger !== undefined) return event.ledger;
  const previous = new Map(prior.map(entry => [`${entry.kind}\0${entry.text}`, entry]));
  return [
    ...(event.assumptions || []).map(text => {
      const old = previous.get(`assumption\0${text}`);
      return { id: old?.id || idFor(item, 'assumption', text), kind: 'assumption', text,
        status: old?.status || 'unverified', refs: old?.refs || [] };
    }),
    ...(event.open_questions || []).map(text => {
      const old = previous.get(`question\0${text}`);
      return { id: old?.id || idFor(item, 'question', text), kind: 'question', text,
        status: old?.status || 'open', refs: old?.refs || [] };
    }),
  ];
}

export function validLedger(value, assumptions = [], questions = []) {
  if (!Array.isArray(value) || value.length !== assumptions.length + questions.length) return false;
  const ids = new Set();
  return value.every(entry => entry && typeof entry.id === 'string' && /^ledger:[a-f0-9]{24}$/.test(entry.id)
    && !ids.has(entry.id) && (ids.add(entry.id), true)
    && ['assumption', 'question'].includes(entry.kind) && typeof entry.text === 'string'
    && statuses[entry.kind].has(entry.status) && Array.isArray(entry.refs)
    && entry.refs.every(ref => typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref))
    && (entry.kind === 'assumption' ? assumptions : questions).includes(entry.text));
}

export function rebuildLedger(store) {
  store.db.exec('DELETE FROM ledger_entries');
  const insert = store.db.prepare(`INSERT INTO ledger_entries(item,ledger_id,kind,text,status,refs,spec_hash,seq)
    VALUES(?,?,?,?,?,?,?,?)`);
  for (const { item } of store.db.prepare("SELECT DISTINCT item FROM events").all()) {
    for (const row of store.eventRows(item)) {
      const event = store.eventFromRow(row);
      if (event.type !== 'specced' || !Array.isArray(event.ledger)) continue;
      for (const entry of event.ledger) insert.run(item, entry.id, entry.kind, entry.text, entry.status,
        JSON.stringify(entry.refs), event.body_hash, row.seq);
    }
  }
}

export function ledgerFor(events, specHash) {
  return events.find(event => event.type === 'specced' && event.body_hash === specHash)?.ledger || [];
}
