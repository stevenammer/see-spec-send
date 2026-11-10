import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../core/store.js';

let tick = 0;
const at = () => `2026-11-09T00:00:${String(++tick).padStart(2, '0')}.000Z`;
const event = (type, actor, body = {}) => ({ type, actor, at: at(), ...body });
const temp = () => mkdtempSync(join(tmpdir(), 'sss-'));

function actors(store, item = 'i') {
  for (const id of ['member', 'steward', 'helper', 'other']) store.registerPerson(id);
  store.registerPerson('leader', { leader: true });
  store.registerPerson('approver', { leader: true });
  store.registerToken('gateway', { kind: 'gateway', item });
  store.registerToken('run', { kind: 'run', item });
}

function ready(store, item = 'i', cap = 1) {
  actors(store, item);
  store.append(item, event('checked', 'steward', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }), { idem: '1' });
  store.append(item, event('specced', 'steward', { must: ['x'], how_we_know: ['x'], out_of_scope: [] }), { idem: '2' });
  const spec = store.events(item).at(-1).body_hash;
  store.append(item, event('approved', 'approver', { spec_hash: spec, cap_usd: cap, quorum: 2 }), { idem: '3' });
}

function binding(store, item = 'i') {
  const { approval, specHash } = store.read(item).context;
  return { approval, spec_hash: specHash };
}

test('authority is registry-derived and tokens are item-scoped', () => {
  const store = new Store();
  actors(store);
  assert.throws(() => store.append('i', { ...event('checked', 'member', { problem: 'x', looked: ['x'], found: [], verdict: 'free' }), role: 'leader' }, { idem: 'x' }), /role/);
  assert.throws(() => store.append('i', event('checked', 'nobody', { problem: 'x', looked: ['x'], found: [], verdict: 'free' }), { idem: 'y' }), /unknown/);
  assert.throws(() => store.append('other', event('charged', 'gateway', { usd: 1 }), { idem: 'z' }), /scoped/);
  store.append('i', event('checked', 'steward', { problem: 'x', looked: ['x'], found: [], verdict: 'free' }), { idem: 'ok' });
  assert.equal(store.read('i').context.steward, 'steward');
});

test('append is idempotent, cached, and rebuildable', () => {
  const store = new Store(); ready(store);
  const firstEvent = event('charged', 'gateway', { usd: 0.1, ...binding(store) });
  const first = store.append('i', firstEvent, { idem: '4' });
  const again = store.append('i', firstEvent, { idem: '4' });
  assert.equal(again.idempotent, true);
  assert.deepEqual(store.cache('i'), store.read('i').context);
  store.rebuild();
  assert.deepEqual(store.cache('i'), store.read('i').context);
  assert.throws(() => store.append('i', event('charged', 'gateway', { usd: 0.1, ...binding(store) }), { expectedSeq: 3, idem: '5' }), /stale/);
  assert.equal(first.state, 'SENDING');
});

test('idempotency keys are bound to the complete submitted event', () => {
  const store = new Store(); ready(store);
  const sent = event('charged', 'gateway', { usd: 0, ...binding(store) });
  store.append('i', sent, { idem: 'one' });
  const before = store.events('i').length;
  for (const changed of [
    { ...sent, type: 'failed' }, { ...sent, actor: 'run' }, { ...sent, usd: 0.1 },
    { ...sent, at: '2026-11-09T09:09:09.000Z' },
  ]) {
    assert.throws(() => store.append('i', changed, { idem: 'one' }), /idempotency key reused with a different event/);
    assert.equal(store.events('i').length, before);
  }
});

test('opening an older database backfills submitted event hashes', () => {
  const file = join(temp(), 'upgrade.db'); const store = new Store(file); ready(store);
  const sent = event('charged', 'gateway', { usd: 0, ...binding(store) });
  store.append('i', sent, { idem: 'old' });
  store.db.prepare("UPDATE events SET submitted_hash=NULL WHERE item='i' AND idem='old'").run();
  store.close();
  const reopened = new Store(file);
  assert.equal(reopened.append('i', sent, { idem: 'old' }).idempotent, true);
  assert.ok(reopened.db.prepare("SELECT submitted_hash FROM events WHERE item='i' AND idem='old'").get().submitted_hash);
  reopened.close();
});

test('money is exact micro-dollars and rejects invalid decimal inputs', () => {
  const store = new Store(); ready(store, 'pennies', 1);
  for (let index = 0; index < 100; index += 1) {
    store.append('pennies', event('charged', 'gateway', { usd: 0.01, ...binding(store, 'pennies') }), { idem: `penny-${index}` });
  }
  assert.equal(store.read('pennies').context.spentMicros, 1_000_000);
  assert.throws(() => store.append('pennies', event('charged', 'gateway', { usd: 0.01, ...binding(store, 'pennies') }), { idem: 'penny-over' }), /cap exceeded/);
  const tenths = new Store(); ready(tenths, 'tenths', 0.3);
  for (let index = 0; index < 3; index += 1) {
    tenths.append('tenths', event('charged', 'gateway', { usd: 0.1, ...binding(tenths, 'tenths') }), { idem: `tenth-${index}` });
  }
  assert.equal(tenths.read('tenths').context.spentMicros, 300_000);
  for (const bad of [0.0000001, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const invalid = new Store(); actors(invalid, 'bad');
    invalid.append('bad', event('checked', 'steward', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }), { idem: 'checked' });
    invalid.append('bad', event('specced', 'steward', { must: ['x'], how_we_know: ['x'], out_of_scope: [] }), { idem: 'spec' });
    const spec = invalid.events('bad').at(-1).body_hash;
    assert.throws(() => invalid.append('bad', event('approved', 'approver', { spec_hash: spec, cap_usd: bad, quorum: 1 }), { idem: 'approval' }), /event not allowed/);
  }
  for (const bad of [0.0000001, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => tenths.append('tenths', event('charged', 'gateway', { usd: bad, ...binding(tenths, 'tenths') }), { idem: `bad-charge-${String(bad)}` }), /invalid usd/);
  }
});

test('a superseded builder cannot spend or deliver under a newer approval', () => {
  const store = new Store(); actors(store, 'A');
  store.append('A', event('checked', 'steward', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }), { idem: '1' });
  store.append('A', event('specced', 'steward', { must: ['v1'], how_we_know: ['k'], out_of_scope: [] }), { idem: '2' });
  const v1 = store.events('A').at(-1).body_hash;
  const first = store.append('A', event('approved', 'leader', { spec_hash: v1, cap_usd: 1, quorum: 1 }), { idem: '3' });
  assert.deepEqual(first.effects, [{ kind: 'build.start', approval: 1, spec_hash: v1, cap_usd: 1 }]);
  store.append('A', event('specced', 'steward', { must: ['v2'], how_we_know: ['k'], out_of_scope: [] }), { idem: '4' });
  const v2 = store.events('A').at(-1).body_hash;
  store.append('A', event('approved', 'leader', { spec_hash: v2, cap_usd: 1, quorum: 1 }), { idem: '5' });
  assert.throws(() => store.append('A', event('tried', 'run', { artifact_hash: 'from-v1', approval: 1, spec_hash: v1 }), { idem: 'stale-tried' }), /approval does not match current approval/);
  assert.throws(() => store.append('A', event('charged', 'gateway', { usd: 1, approval: 1, spec_hash: v1 }), { idem: 'stale-charge' }), /approval does not match current approval/);
  assert.throws(() => store.append('A', event('failed', 'run', { approval: 1, spec_hash: v1 }), { idem: 'stale-failed' }), /approval does not match current approval/);
  assert.equal(store.read('A').context.spentMicros, 0);
  store.append('A', event('charged', 'gateway', { usd: 1, ...binding(store, 'A') }), { idem: 'fresh-charge' });
  assert.equal(store.read('A').context.spentMicros, 1_000_000);
  assert.equal(store.append('A', event('tried', 'run', { artifact_hash: 'from-v2', ...binding(store, 'A') }), { idem: 'fresh-tried' }).state, 'TRYING');
});

test('erasure is authorized, item-scoped, timestamped, and verifiable', () => {
  const store = new Store();
  actors(store, 'a'); actors(store, 'b');
  for (const item of ['a', 'b']) store.append(item, event('checked', 'steward', { problem: 'same', looked: ['same'], found: [], verdict: 'free' }), { idem: item });
  const a = store.events('a')[0].body_hash;
  const b = store.events('b')[0].body_hash;
  assert.notEqual(a, b);
  assert.throws(() => store.erase('a', a, 'member', at()), /not allowed/);
  store.erase('a', a, 'steward', '2026-11-09T01:02:03.000Z');
  assert.equal(store.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(a), undefined);
  assert.ok(store.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(b));
  assert.equal(store.events('a').at(-1).at, '2026-11-09T01:02:03.000Z');
  assert.deepEqual(store.verify('a'), { ok: true });
  assert.throws(() => store.erase('a', b, 'steward', at()), /not part/);
});

test('verification recomputes the chain', () => {
  const store = new Store(); ready(store);
  store.db.prepare("UPDATE events SET actor='tampered' WHERE item='i' AND seq=2").run();
  assert.equal(store.verify('i').ok, false);
});

test('transfer verifies order, content, authority, and is idempotent', () => {
  const source = new Store(); ready(source);
  const text = source.exportJsonl();
  const target = new Store(); actors(target);
  target.importJsonl(text);
  assert.equal(target.exportJsonl(), text);
  const imported = JSON.parse(text.split('\n')[0]);
  imported.submitted_hash = 'different';
  assert.throws(() => target.importRow(imported), /conflicting import/);
  target.importJsonl(text);
  assert.equal(target.exportJsonl(), text);
  for (const hostile of [
    text.replace('steward', 'forged'),
    text.split('\n').filter(Boolean).reverse().join('\n'),
    text.split('\n').slice(0, -2).join('\n'),
  ]) {
    const fresh = new Store(); actors(fresh);
    assert.throws(() => fresh.importJsonl(hostile));
    assert.equal(fresh.events('i').length, 0);
  }
  const role = JSON.parse(text.split('\n')[0]);
  role.bytes = JSON.stringify({ role: 'leader', looked: ['x'], found: [], verdict: 'build_needed' });
  const bad = `${JSON.stringify(role)}\n`;
  const fresh = new Store(); actors(fresh);
  assert.throws(() => fresh.importJsonl(bad));
});

function child(file, code, args = []) {
  return new Promise(resolve => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', code, file, ...args]);
    childProcess.on('close', status => resolve(status));
  });
}

test('real writers serialize charges and stale revisions', async () => {
  const file = join(temp(), 'shared.db'); const store = new Store(file); ready(store, 'i', 1); store.close();
  const module = new URL('../core/store.js', import.meta.url).pathname;
  const charge = `import {Store} from '${module}';const s=new Store(process.argv[1]);
    const c=s.read('i').context;try{s.append('i',{type:'charged',actor:'gateway',usd:.01,approval:c.approval,spec_hash:c.specHash,at:process.argv[2]},{idem:process.argv[2]});process.exit(0)}catch{process.exit(1)}`;
  const outcomes = await Promise.all(Array.from({ length: 120 }, (_, index) =>
    child(file, charge, [`charge-${index}`])));
  const reopened = new Store(file); const rows = reopened.eventRows('i');
  assert.equal(outcomes.filter(code => code === 0).length, 100);
  assert.equal(reopened.read('i').context.spentMicros, 1_000_000);
  assert.equal(new Set(rows.map(row => row.seq)).size, rows.length);
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: rows.length }, (_, i) => i + 1));
  assert.deepEqual(reopened.verify('i'), { ok: true });
  const race = `import {Store} from '${module}';const s=new Store(process.argv[1]);
    const c=s.read('i').context;try{s.append('i',{type:'charged',actor:'gateway',usd:0,approval:c.approval,spec_hash:c.specHash,at:process.argv[2]},{expectedSeq:103,idem:process.argv[2]});process.exit(0)}catch{process.exit(1)}`;
  const paired = await Promise.all([child(file, race, ['race-a']), child(file, race, ['race-b'])]);
  assert.equal(paired.filter(code => code === 0).length, 1);
});

test('SIGKILL at varied moments leaves a replayable cache', async () => {
  const module = new URL('../core/store.js', import.meta.url).pathname;
  const writer = `import {Store} from '${module}';const s=new Store(process.argv[1]);
    for(let i=0;;i++){try{const c=s.read('i').context;s.append('i',{type:'charged',actor:'gateway',usd:0,approval:c.approval,spec_hash:c.specHash,at:String(i)},{idem:String(i)})}catch{}}`;
  for (let run = 0; run < 25; run += 1) {
    const file = join(temp(), 'crash.db'); const store = new Store(file); ready(store); store.close();
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', writer, file]);
    await new Promise(resolve => setTimeout(resolve, 2 + (run % 9) * 3));
    childProcess.kill('SIGKILL'); await new Promise(resolve => childProcess.on('close', resolve));
    const reopened = new Store(file);
    assert.deepEqual(reopened.verify('i'), { ok: true }, `run ${run}`);
    assert.deepEqual(reopened.cache('i'), reopened.read('i').context, `run ${run}`);
    reopened.close();
  }
});

test('core has no actor counters, clock, or randomness', () => {
  for (const file of ['core/machine.js', 'core/store.js']) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /GROUP\s+BY\s+actor|count\s*\(.*actor|Math\.random|Date\s*\./i);
  }
});
