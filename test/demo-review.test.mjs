import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLog, restoreLog } from '../demo/lib/log.js';
import { createSession, perform, limits, restoreArtifacts } from '../demo/lib/flow.js';
import { makeRoster, item, people } from '../demo/lib/roster.js';
import { renderTour } from '../demo/lib/render.js';
import { tourSteps } from '../demo/lib/tour.js';
import { fakeDocument, Node, textOf } from './demo-fakedom.mjs';

const read = path => readFileSync(new URL(`../demo/${path}`, import.meta.url), 'utf8');
const fresh = () => createSession({ log: createLog({ roster: makeRoster(), item }), roster: makeRoster() });

test('an empty tour draws no stray "null" text', () => {
  const root = new Node('div');
  renderTour(fakeDocument, root, [], tourSteps.length);
  assert.doesNotMatch(textOf(root), /null|undefined/);
});

test('visitor-facing copy uses contractions', () => {
  const bad = /\b(did|does|do|is|are|was|has|have|would|should|could|will) not\b|\bcannot\b|\b(That|There|It|Here|What) is\b|we will know/;
  for (const name of ['index.html', 'app.js', 'lib/render.js', 'lib/rules.js', 'lib/tour.js', 'lib/flow.js']) {
    const lines = read(name).split('\n').filter(line => !/^\s*\/\//.test(line)).map(line => line.replace(/[a-z]+(-cannot-[a-z]+)['"]?/g, ''));
    lines.forEach(line => assert.doesNotMatch(line, bad, `${name}: ${line.trim()}`));
  }
  assert.doesNotMatch(readFileSync(new URL('../docs/DEMO.md', import.meta.url), 'utf8'), bad);
});

test('the roster list cannot be edited from the console', () => {
  assert.ok(Object.isFrozen(people));
  assert.ok(people.every(person => Object.isFrozen(person)));
});

test('a saved log with too many rows is refused, not replayed', async () => {
  const rows = Array.from({ length: limits.steps + 1 }, () => ({}));
  assert.equal(await restoreLog({ item, rows }, { roster: makeRoster(), item }), null);
});

test('a session stops accepting steps at the cap', async () => {
  const session = fresh();
  await perform(session, 'maya', 'post', { problem: 'p', verdict: 'build_needed', checks: { have: { on: true, note: '' } } });
  session.log.append = async () => { throw new Error('should not be called'); };
  Object.defineProperty(session.log, 'length', { value: limits.steps });
  const out = await perform(session, 'maya', 'spec', { must: 'a', how_we_know: 'b' });
  assert.equal(out.status, 'invalid');
});

test('saved try text is only kept when it matches its hash', async () => {
  const log = createLog({ roster: makeRoster(), item });
  const real = await log.hashArtifact('One page.');
  const kept = await restoreArtifacts(log, [[real, 'One page.'], [real + 'x', 'Other'], [real, 'FAKE'], ['h', 5]]);
  assert.deepEqual([...kept], [[real, 'One page.']]);
});
