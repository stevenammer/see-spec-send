import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { extractDeltas } from '../knowledge/delta.js';
import { findImpacts } from '../reanalysis/match.js';

const at = '2026-11-10T12:00:00.000Z';
const now = '2026-11-16T12:00:00.000Z';

test('reanalysis cannot copy a restricted source into a target whose steward lacks source access', t => {
  const store = new Store(); t.after(() => store.close());
  for (const id of ['source-steward', 'target-steward']) store.registerPerson(id);
  store.registerPerson('decider', { leader: true });
  store.groupCreate('source-only', 'synthetic restricted group');
  store.groupAdd('source-only', 'source-steward');
  let n = 0;
  const add = (item, event) => store.append(item, { ...event, at }, { idem: `cross-scope-${++n}` });
  const bind = item => ({ post_id: store.read(item).context.activePost.id, post_version: store.read(item).context.activePost.version });
  const frozen = (item, actor, audience, assumption, reason) => {
    add(item, { type: 'posted', actor, rules: 3, original: `${item} workflow`, ...(audience ? { audience } : {}) });
    add(item, { type: 'specced', actor, see_hash: store.read(item).context.seeHash, must: ['Keep the record'], how_we_know: ['It is visible'], out_of_scope: [], assumptions: [assumption], open_questions: [], ...bind(item) });
    const spec = store.read(item).context.specHash, packet = store.putArtifact(item, JSON.stringify({ specHash: spec }));
    add(item, { type: 'sent', actor, spec_hash: spec, packet_hash: packet, ...bind(item) });
    add(item, { type: 'decided', actor: 'decider', disposition: 'decline', reason_code: 'budget', reason, metadata: {}, spec_hash: spec, packet_hash: packet, ...bind(item) });
  };
  frozen('restricted-source', 'source-steward', ['source-only'], 'alpha beta gamma implementation.', 'Secret alpha beta gamma result is now available.');
  frozen('open-target', 'target-steward', null, 'alpha beta gamma implementation.', 'No budget for alpha beta gamma implementation.');
  assert.equal(store.canRead('target-steward', 'restricted-source'), false, 'the target steward is not in the source audience');
  const delta = extractDeltas(store, { now }).find(row => row.source.item === 'restricted-source' && /Secret alpha beta gamma/.test(row.claims.map(claim => claim.text).join(' ')));
  assert.ok(delta, 'synthetic restricted decision becomes a delta');

  const impact = findImpacts(store, delta);
  assert.equal(impact.checked.length, 0, 'a non-reader of the source must not receive an annex quoting it');
});
