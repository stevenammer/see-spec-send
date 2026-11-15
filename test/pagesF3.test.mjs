import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { itemPage } from '../app/pages.js';

function setup() {
  const store = new Store();
  store.registerPerson('op'); store.registerPerson('member'); store.registerPerson('leader', { leader: true });
  let n = 0;
  const append = event => store.append('pages', { ...event, at: new Date(Date.UTC(2026, 10, 14, 0, 0, ++n)).toISOString() }, { idem: `pages:${n}` });
  append({ type: 'posted', actor: 'op', original: 'Callers repeat their details.', rules: 2 });
  const see = store.read('pages').context.seeHash;
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep the note'], how_we_know: ['Callers stop repeating'], out_of_scope: [] });
  const spec = store.read('pages').context.specHash;
  const packet = store.putArtifact('pages', JSON.stringify({ specHash: spec, research: 'nothing checked' }));
  append({ type: 'sent', actor: 'op', spec_hash: spec, packet_hash: packet });
  const render = (person = 'member', leader = false, extra = {}) => itemPage({ id: 'pages', ...store.read('pages'), packet: store.artifact('pages', packet), decisionPackets: { [packet]: store.artifact('pages', packet) }, ...extra }, store.events('pages'), person, leader);
  return { store, append, render, spec, packet, see };
}

test('F3 decision controls expose a configurable time and iteration leash only to an independent leader', () => {
  const { render } = setup();
  const leader = render('leader', true);
  assert.match(leader, /name="window_minutes" type="number" min="1" step="1" value="10080" required/);
  assert.match(leader, /name="max_iterations" type="number" min="1" max="5"/);
  assert.match(leader, /name="password" type="password" required/);
  assert.match(leader, /data-event="returned"><input type="hidden" name="spec_hash"/);
  assert.match(leader, /Effort daily limits: 10 mention replies per person, 30 per item/);
  assert.match(leader, /separate limit of 50 per person, 2 per item/);
  assert.doesNotMatch(leader, /replies left today|2 left/);
  assert.match(leader, /data-event="not_built"/);
  for (const page of [render(), render('op', true)]) assert.doesNotMatch(page, /data-approve|data-event="not_built"|data-event="returned"/);
});

test('F3 members see the reviewed evidence, concrete reason, restricted receipt and pivot record after Not building', () => {
  const { append, render, spec, packet } = setup();
  append({ type: 'not_built', actor: 'leader', spec_hash: spec, packet_hash: packet,
    reason: 'Use the existing <handoff> view first.', restricted_evidence: 'a restricted source exists; ask Privacy', pivot_note: 'A wider trial provided new evidence.' });
  const page = render();
  assert.match(page, /<h2>Decision history<\/h2>/);
  assert.match(page, /Not building/);
  assert.match(page, /Use the existing &lt;handoff&gt; view first\./);
  assert.match(page, /a restricted source exists; ask Privacy/);
  assert.match(page, /What changed: A wider trial provided new evidence\./);
  assert.match(page, /Reviewed evidence snapshot/);
  assert.match(page, /nothing checked/);
  assert.doesNotMatch(page, /<handoff>/);
});

test('F3 returned decisions retain their reviewed snapshot when a newer spec is written', () => {
  const { append, render, spec, packet, see } = setup();
  append({ type: 'returned', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'Check whether the current handoff view already works.' });
  append({ type: 'specced', actor: 'op', see_hash: see, must: ['Keep a clearer note'], how_we_know: ['Callers stop repeating'], out_of_scope: [] });
  const page = render();
  assert.match(page, /<h3>Returned<\/h3>/);
  assert.ok(page.includes(`Reviewed spec: ${spec}`));
  assert.match(page, /Reviewed evidence snapshot/);
});

test('F3 approved leash stays visible to a member with its exact resource bounds', () => {
  const { append, render, spec, packet } = setup();
  append({ type: 'approved', actor: 'leader', spec_hash: spec, packet_hash: packet, reason: 'A small independent trial will answer this.', cap_usd: 2.5, quorum: 2, max_iterations: 2, window_minutes: 30, expires_at: '2026-11-14T00:30:04.000Z' });
  const page = render();
  assert.match(page, /Approval leash/);
  assert.match(page, /up to 2 additional build turns, 30 minutes, until 2026-11-14T00:30:04.000Z/i);
  assert.match(page, /Cap: \$2\.50/);
  assert.match(page, /2 independent people must say it helps/);
});

test('F3 erasure leaves an attributable escaped tombstone in the public history', () => {
  const { store, append, render, see } = setup();
  append({ type: 'commented', actor: 'member', comment: 'Private caller detail.', kind: 'comment', anchor_kind: 'see', anchor_hash: see });
  const target = store.events('pages').at(-1).body_hash;
  store.erase('pages', target, 'leader', '2026-11-14T00:00:05.000Z', { ground: 'privacy', note: 'Remove <private> caller data.' });
  const page = render();
  assert.match(page, /<h2>Erased content<\/h2>/);
  assert.match(page, /Content erased by leader/);
  assert.match(page, /Ground: privacy\. Remove &lt;private&gt; caller data\./);
  assert.doesNotMatch(page, /Private caller detail\./);
  assert.match(page, /\[erased\]/);
});

// Exercise the browser serializer without a DOM: the form and network contract are the boundary.
async function submit(dataset, fields) {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  let handler;
  const calls = [];
  const context = {
    FormData: class { constructor() { return Object.entries(fields); } },
    document: { addEventListener: (_name, callback) => { handler = callback; } },
    location: { pathname: '/items/pages', reload() {} },
    fetch: async (path, options) => {
      if (options) calls.push({ path, data: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ csrf: 'fixture' }) };
    },
  };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await handler({ preventDefault() {}, target: { dataset, matches: () => true, hasAttribute: () => false } });
  return calls;
}

test('F3 browser submits legacy approval without null leash fields, while preserving explicit new limits', async () => {
  const legacy = await submit({ approve: 'true' }, { password: 'fixture', spec_hash: 'spec', cap_usd: '1', quorum: '1', expected_seq: '3' });
  assert.deepEqual(legacy.at(-1).data, { type: 'approved', spec_hash: 'spec', cap_usd: 1, quorum: 1, expected_seq: 3 });
  const current = await submit({ approve: 'true' }, { password: 'fixture', spec_hash: 'spec', packet_hash: 'packet', reason: 'A clear small trial.', cap_usd: '1', quorum: '1', max_iterations: '2', window_minutes: '60' });
  assert.equal(current.at(-1).data.max_iterations, 2);
  assert.equal(current.at(-1).data.window_minutes, 60);
});

test('F3 browser omits blank optional decision evidence and sends research refresh and OP estimate', async () => {
  const decision = await submit({ event: 'not_built' }, { reason: 'The existing view covers this.', spec_hash: 'spec', packet_hash: 'packet', restricted_evidence: '', pivot_note: '  ' });
  assert.deepEqual(decision.at(-1).data, { type: 'not_built', reason: 'The existing view covers this.', spec_hash: 'spec', packet_hash: 'packet' });
  assert.deepEqual(await submit({ research: 'true' }, {}), [{ path: '/api/items/pages/research', data: {} }]);
  const sent = await submit({ send: 'true' }, { spec_hash: 'spec', estimate: '  One hour, estimated by OP.  ' });
  assert.deepEqual(sent.at(-1).data, { spec_hash: 'spec', estimate: 'One hour, estimated by OP.' });
});
