import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../core/store.js';
import { createLog, stable } from '../demo/lib/log.js';
import { explain } from '../demo/lib/rules.js';
import { createSession, perform, summary } from '../demo/lib/flow.js';
import { makeRoster, item as demoItem } from '../demo/lib/roster.js';
import { tourSteps, playAll } from '../demo/lib/tour.js';

const storyDir = new URL('./stories/', import.meta.url);
const stories = readdirSync(storyDir).filter(name => name.endsWith('.jsonl')).sort().map(name => ({
  name: name.replace('.jsonl', ''),
  events: readFileSync(new URL(name, storyDir), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
}));

// The stories are written for the machine. Their `role` field is a hint for who the actor is,
// never authority. Build a registry from it, the same registry for the Store and for the demo log.
function registryFor(events) {
  const registry = {};
  // Stories name the steward by role ("steward-1"), not by id: it means whoever the item's steward is.
  // That person is the one who made the first `checked` event, so they are already registered.
  for (const event of events.filter(entry => entry.role !== 'steward')) {
    const entry = registry[event.actor] ??= { kind: 'person', leader: false };
    if (event.role === 'leader') entry.leader = true;
    if (event.role === 'run') entry.kind = 'run';
  }
  for (const event of events) {
    if (event.type === 'steward_changed') registry[event.steward] ??= { kind: 'person', leader: false };
  }
  return registry;
}

// What each story is supposed to end in, written from reading the stories. `refused` lists the
// 1-based positions the machine must refuse.
const expected = {
  'already-have': { state: 'SHELVED', refused: [] },
  happy: { state: 'HELPS', refused: [] },
  'past-shapers-cannot-help': { state: 'TRYING', refused: [7] },
  shelved: { state: 'SHELVED', refused: [] },
  'spec-change-sending': { state: 'SPECCED', refused: [] },
  'stale-approval': { state: 'SENDING', refused: [6] },
  'stale-artifact': { state: 'TRYING', refused: [5] },
  'rules-2-posted': { state: 'SEEN', refused: [] },
  'rules-2-journey': { state: 'SPECCED', refused: [] },
  'rules-2-refusals': { state: 'SPECCED', refused: [2, 4] },
};

const at = index => `2026-11-09T00:00:${String(index).padStart(2, '0')}.000Z`;

async function replayBoth(story) {
  const registry = registryFor(story.events);
  const store = new Store();
  const roster = {};
  for (const [id, entry] of Object.entries(registry)) {
    if (entry.kind === 'person') { store.registerPerson(id, { leader: entry.leader }); roster[id] = { kind: 'person', leader: entry.leader, item: null }; }
    else { store.registerToken(id, { kind: 'run', item: 'i' }); roster[id] = { kind: 'run', leader: false, item: 'i' }; }
  }
  const log = createLog({ roster, item: 'i' });
  const aliases = new Map();
  const steps = [];
  for (const [index, source] of story.events.entries()) {
    const event = { ...source, at: at(index + 1) };
    if (source.role === 'steward') event.actor = store.read('i').context.steward ?? event.actor;
    delete event.role;
    for (const key of ['see_hash', 'spec_hash', 'anchor_hash', 'base_hash']) {
      if (aliases.has(event[key])) event[key] = aliases.get(event[key]);
    }
    const idem = `k${index + 1}`;
    let storeOutcome;
    try { storeOutcome = { ok: true, ...store.append('i', event, { idem }) }; }
    catch (error) { storeOutcome = { ok: false, error: error.message }; }
    const demoOutcome = await log.append(event, { idem });
    if (storeOutcome.ok && source.body_hash) aliases.set(source.body_hash, store.events('i').at(-1).body_hash);
    steps.push({ index: index + 1, event, storeOutcome, demoOutcome });
  }
  return { store, log, steps };
}

for (const story of stories) {
  test(`parity: story "${story.name}" gives the same result in the real Store and the demo log`, async () => {
    const { store, log, steps } = await replayBoth(story);
    for (const { index, storeOutcome, demoOutcome } of steps) {
      assert.equal(demoOutcome.ok, storeOutcome.ok, `event ${index}: accepted or refused`);
      if (!storeOutcome.ok) assert.equal(demoOutcome.error, storeOutcome.error, `event ${index}: same refusal`);
      else {
        assert.equal(demoOutcome.state, storeOutcome.state, `event ${index}: state`);
        assert.equal(stable(demoOutcome.context), stable(storeOutcome.context), `event ${index}: context`);
        assert.equal(demoOutcome.hash, storeOutcome.hash, `event ${index}: chain hash`);
      }
    }
    const final = store.read('i');
    assert.equal(log.replay().state, final.state);
    assert.equal(stable(log.replay().context), stable(final.context));
    assert.deepEqual(log.rows().map(row => row.hash), store.eventRows('i').map(row => row.hash));
    assert.deepEqual(log.rows().map(row => row.bodyHash), store.eventRows('i').map(row => row.body_hash));
    assert.equal((await log.verify()).ok, true);
    assert.equal(store.verify('i').ok, true);
    // The story's own expectation, independent of the Store.
    assert.equal(final.state, expected[story.name].state);
    assert.deepEqual(steps.filter(step => !step.storeOutcome.ok).map(step => step.index), expected[story.name].refused);
    store.close();
  });
}

test('every story file has an expectation, so a new story cannot be skipped', () => {
  assert.deepEqual(stories.map(story => story.name).sort(), Object.keys(expected).sort());
});

test('the refusals in the stories are explained by the rule that fired', async () => {
  const wanted = { 'past-shapers-cannot-help': 'past-shaper-cannot-help', 'stale-artifact': 'stale-artifact', 'stale-approval': 'stale-approval' };
  for (const story of stories.filter(entry => wanted[entry.name])) {
    const { log, steps } = await replayBoth(story);
    const refused = steps.find(step => !step.demoOutcome.ok);
    // Rebuild the state just before the refused event from the accepted prefix.
    const prefix = steps.slice(0, refused.index - 1).filter(step => step.demoOutcome.ok);
    const before = createLog({ roster: registryRoster(story), item: 'i' });
    for (const step of prefix) await before.append(step.event, { idem: `k${step.index}` });
    const authority = registryRoster(story)[refused.event.actor];
    const why = explain(before.replay().context, refused.event, authority, refused.demoOutcome.error);
    assert.equal(why.rule, wanted[story.name], story.name);
    assert.ok(log);
  }
});

function registryRoster(story) {
  const roster = {};
  for (const [id, entry] of Object.entries(registryFor(story.events))) roster[id] = { ...entry, item: entry.kind === 'run' ? 'i' : null };
  return roster;
}

test('the tour matches docs/WATCH_IT_REFUSE.md line for line and ends in Helps', async () => {
  const doc = readFileSync(new URL('../docs/WATCH_IT_REFUSE.md', import.meta.url), 'utf8');
  const block = doc.split('```text\n')[1].split('```')[0];
  const lines = block.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^(\w+)\s+(.+?)\s+(\d{3}) (accepted|refused)\s+item is (\w+)(?: \((\d+) of (\d+) helpers\))?$/);
    assert.ok(match, `could not parse: ${line}`);
    return { who: match[1], label: match[2], outcome: match[4], state: match[5], helpers: match[6] ? Number(match[6]) : null, quorum: match[7] ? Number(match[7]) : null };
  });
  assert.equal(lines.length, 9);
  const session = createSession({ log: createLog({ roster: makeRoster(), item: demoItem }), roster: makeRoster() });
  const played = await playAll(session);
  assert.equal(played.length, lines.length);
  played.forEach((entry, index) => {
    const want = lines[index];
    assert.equal(entry.step.who, want.who);
    assert.equal(entry.outcome.status, want.outcome, `step ${index + 1}`);
    assert.equal(entry.state.state, want.state, `step ${index + 1}`);
    if (want.helpers !== null) { assert.equal(entry.state.helpers, want.helpers); assert.equal(entry.state.quorum, want.quorum); }
    // Labels match except step 4, where the demo says honestly that its try is a note.
    if (index !== 3) assert.equal(entry.step.label, want.label);
  });
  const refused = played.filter(entry => entry.outcome.status === 'refused');
  assert.equal(refused.length, 3);
  assert.deepEqual(refused.map(entry => entry.outcome.rule), ['author-cannot-help', 'approver-cannot-help', 'no-done-event']);
  assert.equal(summary(session).state, 'HELPS');
  assert.equal((await session.log.verify()).ok, true);
  assert.equal(tourSteps.filter(step => step.expect === 'refused').length, 3);
});

test('authority comes from the roster, not from the event', async () => {
  const roster = makeRoster();
  const log = createLog({ roster, item: demoItem });
  const base = { at: at(1) };
  assert.equal((await log.append({ ...base, type: 'checked', actor: 'maya', problem: 'x', looked: ['have:x'], found: [], verdict: 'build_needed' }, { idem: 'a' })).ok, true);
  assert.equal((await log.append({ ...base, type: 'specced', actor: 'maya', must: ['x'], how_we_know: ['y'], out_of_scope: [] }, { idem: 'b' })).ok, true);
  // Ben claims leadership in every way an event can. He is a member in the roster.
  const claim = await log.append({ ...base, type: 'approved', actor: 'ben', leader: true, kind: 'person', authority: { leader: true },
    spec_hash: log.replay().context.specHash, cap_usd: 1, quorum: 1 }, { idem: 'c' });
  assert.equal(claim.ok, false);
  assert.equal(claim.error, 'event not allowed');
  assert.equal((await log.append({ ...base, type: 'approved', actor: 'ben', role: 'leader' }, { idem: 'd' })).error, 'event role is forbidden');
  assert.equal((await log.append({ ...base, type: 'approved', actor: 'nobody' }, { idem: 'e' })).error, 'unknown actor');
  assert.equal(log.length, 2);
});

test('the chain notices edits, reordering and removal', async () => {
  const { log } = await replayBoth(stories.find(story => story.name === 'happy'));
  assert.equal((await log.verify()).ok, true);
  assert.equal(log.tamper(2), true);
  assert.deepEqual(await log.verify(), { ok: false, seq: 2, reason: 'body' });
});

test('idempotent retries do not grow the log, and a reused key with a different event is refused', async () => {
  const log = createLog({ roster: makeRoster(), item: demoItem });
  const first = { at: at(1), type: 'checked', actor: 'maya', problem: 'x', looked: ['have:x'], found: [], verdict: 'build_needed' };
  assert.equal((await log.append(first, { idem: 'same' })).ok, true);
  assert.equal((await log.append(first, { idem: 'same' })).idempotent, true);
  assert.equal(log.length, 1);
  assert.equal((await log.append({ ...first, problem: 'y' }, { idem: 'same' })).error, 'idempotency key reused with a different event');
});

test('a hand-edited saved log is not restored', async () => {
  const { restoreLog } = await import('../demo/lib/log.js');
  const session = createSession({ log: createLog({ roster: makeRoster(), item: demoItem }), roster: makeRoster() });
  await playAll(session);
  const saved = JSON.parse(JSON.stringify(session.log.toJSON()));
  const options = { roster: makeRoster(), item: demoItem };
  assert.ok(await restoreLog(saved, options));
  saved.rows[1].bytes = saved.rows[1].bytes.replace('Show each refund once', 'Do anything');
  assert.equal(await restoreLog(saved, options), null);
  assert.equal(await restoreLog({ item: demoItem, rows: [{ bytes: '{not json' }] }, options), null);
});

test('the visitor path reaches the already-have ending and the shelved ending', async () => {
  const mk = () => createSession({ log: createLog({ roster: makeRoster(), item: demoItem }), roster: makeRoster() });
  const checks = { have: { on: true, note: 'It was a setting' } };
  let session = mk();
  assert.equal((await perform(session, 'ben', 'post', { problem: 'Reports are slow', verdict: 'already_have', checks })).status, 'accepted');
  assert.equal(summary(session).state, 'SHELVED');
  assert.equal((await perform(session, 'ben', 'spec', { must: 'a', how_we_know: 'b' })).status, 'refused');
  session = mk();
  await perform(session, 'ben', 'post', { problem: 'Reports are slow', verdict: 'build_needed', checks });
  assert.equal((await perform(session, 'lena', 'shelve', { reason: 'not now' })).status, 'accepted');
  assert.equal(summary(session).state, 'SHELVED');
});

test('a leader who is the steward cannot approve, and a member cannot approve', async () => {
  const session = createSession({ log: createLog({ roster: makeRoster(), item: demoItem }), roster: makeRoster() });
  await perform(session, 'lena', 'post', { problem: 'p', verdict: 'build_needed', checks: { have: { on: true, note: '' } } });
  await perform(session, 'lena', 'spec', { must: 'a', how_we_know: 'b' });
  assert.equal((await perform(session, 'lena', 'approve', { cap: '1', quorum: '1' })).rule, 'steward-cannot-approve');
  assert.equal((await perform(session, 'ben', 'approve', { cap: '1', quorum: '1' })).rule, 'leaders-approve');
  assert.equal((await perform(session, 'omar', 'approve', { cap: '1', quorum: '1' })).status, 'accepted');
});
