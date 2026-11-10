// A fixed, invented roster. Authority comes from here and from nowhere else.
// An event never says what its author may do. The log looks the actor up.
export const item = 'item-1';

export const people = Object.freeze([
  { id: 'maya', name: 'Maya', leader: false, note: 'member' },
  { id: 'lena', name: 'Lena', leader: true, note: 'leader' },
  { id: 'ben', name: 'Ben', leader: false, note: 'member' },
  { id: 'cleo', name: 'Cleo', leader: false, note: 'member' },
  { id: 'omar', name: 'Omar', leader: true, note: 'leader' },
  { id: 'priya', name: 'Priya', leader: false, note: 'member' },
].map(person => Object.freeze(person)));

export const runToken = 'run-1';

export function makeRoster() {
  const roster = {};
  for (const person of people) roster[person.id] = Object.freeze({ kind: 'person', leader: person.leader, item: null });
  roster[runToken] = Object.freeze({ kind: 'run', leader: false, item });
  return Object.freeze(roster);
}

export const nameOf = id => people.find(person => person.id === id)?.name ?? id;
