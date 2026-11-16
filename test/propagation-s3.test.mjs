import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { addCapability } from '../knowledge/catalog.js';
import { propagateOpportunities, resolveEdge } from '../reanalysis/propagate.js';

const at = '2026-11-16T12:00:00.000Z';
test('one HELPS capability yields separate unapproved candidates and dismissed candidate is not resent', t => {
  const store = new Store(); t.after(() => store.close());
  for (const id of ['sam', 'riya', 'nina']) store.registerPerson(id);
  store.groupCreate('Reservations', 'night shift export handoff'); store.groupAdd('Reservations', 'riya');
  store.groupCreate('Night Support', 'night shift export handoff'); store.groupAdd('Night Support', 'nina');
  addCapability(store, { summary: 'Export handoff works', tags: ['export', 'handoff'], item: null, at });
  const edges = propagateOpportunities(store, { at });
  assert.equal(edges.length, 2); assert.ok(edges.every(edge => edge.status === 'candidate' && edge.questions.some(question => /Night shift/.test(question))));
  resolveEdge(store, edges[0].hash, 'dismissed', { at: '2026-11-17T12:00:00.000Z' });
  assert.equal(propagateOpportunities(store, { at: '2026-11-18T12:00:00.000Z' }).filter(edge => edge.group === edges[0].group).length, 0);
});
