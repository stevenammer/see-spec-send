import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { initial } from '../core/machine.js';
import { itemPage, forkForm } from '../app/pages.js';
import { specPage } from '../app/pages-spec.js';

const hash = n => String(n).repeat(64);
const events = [
  { type: 'posted', original: 'Original SEE', actor: 'op', body_hash: hash(1), at: '2026-11-15T00:00:00Z' },
  { type: 'specced', actor: 'op', must: ['First spec'], how_we_know: ['First test'], out_of_scope: [], scope: { data_sources: ['fixture'], audiences: ['members'] }, body_hash: hash(2) },
  { type: 'revised', text: 'New SEE', actor: 'op', body_hash: hash(3) },
  { type: 'specced', actor: 'op', must: ['Second spec'], how_we_know: ['Second test'], out_of_scope: [], body_hash: hash(4) },
  { type: 'tried', actor: 'run', artifact_hash: hash(5), body_hash: hash(6) },
];

test('F4 selector identifies historical SEE/spec versions and uses the tried event identity for artifact forks', () => {
  const form = forkForm(events, { artifact: hash(5) });
  assert.match(form, /option value="">Current point/);
  assert.match(form, new RegExp(`value="see:${hash(1)}">SEE v1 \\(historical\\)`));
  assert.match(form, new RegExp(`value="spec:${hash(2)}">Spec v1 \\(historical\\)`));
  assert.match(form, new RegExp(`value="artifact:${hash(6)}">Try 1`));
  assert.doesNotMatch(form, new RegExp(`value="artifact:${hash(5)}"`));
  assert.match(form, /own SEND IT! and independent leader approval/);
});

test('F4 fork seed is visibly an unapproved draft and pre-fills the first spec including its proposed scope', () => {
  const seed = { must: ['Carry <details>'], how_we_know: ['No repetition'], out_of_scope: ['No export'], scope: { data_sources: ['fixture'], audiences: ['members'] } };
  const first = { type: 'forked', actor: 'member', original: 'Old SEE', from: { kind: 'spec', hash: hash(2) }, seed_spec: seed, parent: { item: 'parent', seq: 2, hash: hash(7) }, body_hash: hash(8) };
  const context = { ...initial(), rules: 2, steward: 'member', originator: 'member', authors: ['member'], seeHash: hash(8), seeVersion: 1, parent: first.parent };
  const page = itemPage({ id: 'child', state: 'SEEN', context }, [first], 'member', false);
  assert.match(page, /Fork starting spec \(unapproved draft\)/);
  assert.match(page, /isn't a saved spec or approval to build/);
  assert.match(page, /selected spec event/);
  assert.match(page, /name="must" required>Carry &lt;details&gt;/);
  assert.match(page, /name="scope_data_sources">fixture/);
  assert.match(page, /name="scope_audiences">members/);
  assert.doesNotMatch(page, /data-approve|data-send|Playable try/);
});

test('F4 SPEC page offers historical forks and keeps the saved scope in the OP update form', () => {
  const selected = events.slice(0, 2);
  const context = { ...initial(), rules: 2, steward: 'op', seeHash: hash(1), specHash: hash(2), specVersion: 1 };
  const page = specPage({ id: 'parent', state: 'SPECCED', context }, selected, 'op');
  assert.match(page, /data-fork="true"/);
  assert.match(page, /name="scope_data_sources">fixture/);
  assert.match(page, /name="scope_audiences">members/);
  const memberPage = specPage({ id: 'parent', state: 'SPECCED', context }, selected, 'member');
  assert.match(memberPage, /data-fork="true"/);
  assert.doesNotMatch(memberPage, /data-event="specced"/);
});

async function submit(dataset, fields, scopeFields) {
  let handler; const calls = [];
  const form = { dataset, fields, matches: () => true, hasAttribute: () => false, closest: () => ({ querySelector: () => scopeFields ? { fields: scopeFields } : null }) };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), {
    FormData: class { constructor(target) { return Object.entries(target.fields); } },
    document: { addEventListener(_name, callback) { handler = callback; } },
    crypto: { randomUUID: () => 'fixture-request-key' },
    location: { pathname: '/items/parent/spec', reload() {} },
    fetch: async (path, options) => { if (options) { if (path.endsWith('/fork')) assert.equal(options.headers['idempotency-key'], 'fixture-request-key'); calls.push({ path, data: JSON.parse(options.body) }); } return { ok: true, status: 200, json: async () => ({ csrf: 'fixture', id: 'child' }) }; },
  });
  await handler({ preventDefault() {}, target: form, submitter: { value: 'quoted' } });
  return calls.at(-1);
}

test('F4 fork browser serializer sends an explicit selected event and preserves default current-point compatibility', async () => {
  const selected = await submit({ fork: 'true' }, { reason: 'Try the older spec.', from: `spec:${hash(2)}` });
  assert.deepEqual(selected, { path: '/api/items/parent/fork', data: { reason: 'Try the older spec.', from: { kind: 'spec', hash: hash(2) } } });
  const current = await submit({ fork: 'true' }, { reason: 'Try the current point.', from: '' });
  assert.deepEqual(current.data, { reason: 'Try the current point.' });
});

test('F4 spec publish and comment inclusion preserve typed source/audience scope without granting textual authority', async () => {
  const published = await submit({ event: 'specced' }, { see_hash: hash(1), must: 'Keep details', how_we_know: 'No repetition', out_of_scope: '', scope_data_sources: 'fixture\n', scope_audiences: 'members' });
  assert.deepEqual(published.data.scope, { data_sources: ['fixture'], audiences: ['members'] });
  assert.equal(Object.hasOwn(published.data, 'scope_data_sources'), false);
  const included = await submit({ include: 'spec' }, { see_hash: hash(1), base_spec_hash: hash(2), must: 'Included point', how_we_know: 'It works', out_of_scope: '', comment: hash(3) }, { scope_data_sources: 'fixture', scope_audiences: 'members' });
  assert.deepEqual(included.data.scope, { data_sources: ['fixture'], audiences: ['members'] });
});
