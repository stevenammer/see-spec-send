import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { runCloseoutJobs } from '../core/closeout.js';

const at = '2026-11-16T12:00:00.000Z';

test('security review: erasure removes the old closeout report bytes, not only its live pointer', t => {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('steward'); store.registerPerson('contributor');
  let n = 0;
  const append = event => store.append('case', { ...event, at }, { idem: `review-${++n}` });
  append({ type: 'posted', actor: 'steward', original: 'A harmless operational issue.', rules: 3 });
  const binding = () => ({ post_id: store.read('case').context.activePost.id, post_version: store.read('case').context.activePost.version });
  const see = store.read('case').context.seeHash;
  const secret = 'SYNTHETIC-ERASURE-CLOSEOUT-SECRET';
  append({ type: 'commented', actor: 'contributor', kind: 'alternative', anchor_kind: 'see', anchor_hash: see, comment: secret, ...binding() });
  const commentHash = store.events('case').at(-1).body_hash;
  append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep the issue visible'], how_we_know: ['A reviewer can read it'], out_of_scope: [], ...binding() });
  runCloseoutJobs(store, {});
  const oldHash = store.db.prepare('SELECT artifact_hash FROM closeout_jobs WHERE item=?').get('case').artifact_hash;
  assert.match(store.artifact('case', oldHash), new RegExp(secret));

  store.erase('case', commentHash, 'contributor', at);

  assert.equal(store.artifact('case', oldHash), null,
    'the old report remains in bodies and is readable by its hash after the source is erased');
});
