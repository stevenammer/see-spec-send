import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

const at = '2026-11-16T12:00:00.000Z';

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}

test('security review: an erased source is not still served from the frozen decision packet', async t => {
  const store = new Store(); t.after(() => store.close());
  store.registerPerson('steward'); store.registerPerson('contributor');
  let n = 0;
  const append = event => store.append('case', { ...event, at }, { idem: `packet-${++n}` });
  append({ type: 'posted', actor: 'steward', original: 'A harmless operational issue.', rules: 3 });
  const binding = () => ({ post_id: store.read('case').context.activePost.id, post_version: store.read('case').context.activePost.version });
  const see = store.read('case').context.seeHash;
  const secret = 'SYNTHETIC-ERASURE-PACKET-SECRET';
  append({ type: 'commented', actor: 'contributor', kind: 'comment', anchor_kind: 'see', anchor_hash: see, comment: secret, ...binding() });
  const commentHash = store.events('case').at(-1).body_hash;
  append({ type: 'specced', actor: 'steward', see_hash: see, must: ['Keep the issue visible'], how_we_know: ['A reviewer can read it'], out_of_scope: [], assumptions: [], open_questions: [], ...binding() });
  const specHash = store.read('case').context.specHash;
  const packetHash = store.putArtifact('case', JSON.stringify({ specHash, adopted_comment: secret }));
  append({ type: 'sent', actor: 'steward', spec_hash: specHash, packet_hash: packetHash, ...binding() });

  store.erase('case', commentHash, 'contributor', at);
  const auth = new Auth(store); await auth.createUser('viewer', 'viewer-password-123');
  const login = await auth.login('viewer', 'viewer-password-123', '127.0.0.1');
  const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const req = Readable.from([]); req.method = 'GET'; req.url = '/items/case'; req.headers = { cookie: `sss=${login.value}` }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);

  assert.doesNotMatch(res.text, new RegExp(secret),
    'the item page renders the frozen packet with the erased comment verbatim');
});
