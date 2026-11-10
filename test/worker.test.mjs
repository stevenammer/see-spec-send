import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { FakeAdapter } from '../worker/fake.js';
import { killed, setKill } from '../worker/control.js';
import { main } from '../cli.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'sss-worker-')), 'db');
const put = (s, item, type, actor, body = {}) => s.append(item,
  { type, actor, at: '2026-11-10', ...body }, { idem: `${type}:${s.events(item).length}` });
function ready(s, item = 'i') {
  s.registerPerson('s'); s.registerPerson('l', { leader: true }); s.registerPerson('h');
  put(s, item, 'checked', 's', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' });
  spec(s, item);
  approve(s, item);
}
function spec(s, item = 'i') {
  put(s, item, 'specced', 's', { must: ['x'], how_we_know: ['yes'], out_of_scope: [] });
}
function approve(s, item = 'i') {
  put(s, item, 'approved', 'l', { spec_hash: s.read(item).context.specHash, cap_usd: 0, quorum: 1 });
}
const rows = s => s.db.prepare('SELECT * FROM runs ORDER BY approval').all();
class Waiting extends FakeAdapter {
  status() { return { state: 'running' }; }
}

// Reusable contract: substitute another factory here before accepting another adapter.
export function adapterConformance(name, factory) {
  test(`${name} adapter conformance: identity, recovery, deterministic artifact, stop fence`, () => {
    const s = new Store(file());
    const request = { id: 'fixed', item: 'i', approval: 1, spec_hash: 'a'.repeat(64), cap_micros: 0,
      spec: { must: ['x'], how_we_know: ['yes'], out_of_scope: [] } };
    let adapter = factory(s);
    adapter.start(request); adapter.start(request);
    const first = adapter.status(request.id);
    assert.equal(first.state, 'ready');
    assert.match(first.html, /Small try/);
    assert.ok(Buffer.byteLength(first.html) < 4096);
    adapter = factory(s);
    assert.deepEqual(adapter.status(request.id), first);
    assert.throws(() => adapter.start({ ...request, item: 'other' }), /different input/);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM fake_jobs').get().n, 1);
    adapter.start({ ...request, id: 'second' });
    assert.deepEqual(adapter.status('second'), first);
    adapter.stop('fixed'); adapter.stop('fixed');
    adapter.start(request);
    assert.equal(adapter.status('fixed').state, 'stopped');
    adapter.stop('unstarted');
    assert.throws(() => adapter.start({ ...request, id: 'unstarted' }), /different input/);
    assert.equal(adapter.status('unstarted').state, 'stopped');
    s.close();
  });
}
adapterConformance('fake', s => new FakeAdapter(s));

test('worker delivers once, exact zero spend, and cannot become a helper or leader', () => {
  const s = new Store(); ready(s);
  const w = new Worker(s); w.reconcile();
  const [run] = rows(s);
  const request = JSON.parse(s.db.prepare('SELECT input FROM fake_jobs WHERE id=?').get(run.id).input);
  assert.deepEqual(Object.keys(request.spec).sort(), ['how_we_know', 'must', 'out_of_scope']);
  assert.equal(request.cap_micros, 0);
  assert.equal(request.approval, run.approval);
  assert.equal(request.spec_hash, run.spec_hash);
  assert.equal(s.actor(run.run_actor, 'i').kind, 'run');
  assert.equal(s.actor(run.gateway_actor, 'i').kind, 'gateway');
  assert.equal(s.read('i').state, 'TRYING');
  assert.equal(s.read('i').context.spentMicros, 0);
  assert.equal(s.read('i').context.capMicros, 0);
  assert.equal(w.deliver(run.id, 'duplicate'), false);
  w.reconcile(); w.reconcile();
  assert.equal(rows(s).length, 1);
  assert.equal(s.events('i').filter(e => e.type === 'tried').length, 1);
  assert.equal(rows(s)[0].status, 'stopped');
  assert.equal(new FakeAdapter(s).status(run.id).state, 'stopped');
  const c = s.read('i').context;
  assert.match(s.artifact('i', c.artifact), /Small try/);
  for (const type of ['helped', 'approved', 'steward_changed', 'failed']) {
    assert.throws(() => put(s, 'i', type, run.run_actor,
      { artifact_hash: c.artifact, steward: 'h', approval: run.approval, spec_hash: run.spec_hash }), /not allowed|stopped/);
  }
  assert.equal(s.read('i').state, 'TRYING');
  put(s, 'i', 'helped', 'h', { artifact_hash: c.artifact });
  assert.equal(s.read('i').state, 'HELPS');
  assert.ok(s.verifyAll().every(r => r.ok));
  s.close();
});

test('spec replacement and new approval fence old tokens even with forged current binding', () => {
  const s = new Store(); ready(s); ready(s, 'other');
  const w = new Worker(s, new Waiting(s)); w.reconcile();
  const run = rows(s).find(r => r.item === 'i');
  assert.throws(() => put(s, 'other', 'tried', run.run_actor,
    { approval: 1, spec_hash: run.spec_hash, artifact_hash: 'x' }), /scoped/);
  spec(s); approve(s);
  const c = s.read('i').context;
  for (const [actor, type] of [[run.run_actor, 'tried'], [run.gateway_actor, 'charged']]) {
    assert.throws(() => put(s, 'i', type, actor,
      { approval: c.approval, spec_hash: c.specHash, artifact_hash: 'x', usd: 0 }), /binding/);
  }
  assert.throws(() => w.deliver(run.id, 'stale'), /refused/);
  w.reconcile();
  assert.equal(rows(s).find(r => r.id === run.id).status, 'stopped');
  assert.equal(rows(s).filter(r => r.item === 'i').length, 2);
  s.close();
});

test('exit effects persist stop intent and lost stop responses are retried after restart', () => {
  const path = file(); let s = new Store(path); ready(s);
  let w = new Worker(s, new Waiting(s)); w.reconcile();
  const [run] = rows(s);
  put(s, 'i', 'shelved', 's', { reason: 'enough' });
  assert.equal(rows(s)[0].status, 'stop_requested');
  w.adapter.stop = () => { throw new Error('lost stop response'); };
  assert.throws(() => w.reconcile(), /lost stop/);
  s.close(); s = new Store(path); w = new Worker(s); w.reconcile();
  assert.equal(rows(s)[0].status, 'stopped');
  assert.equal(new FakeAdapter(s).status(run.id).state, 'stopped');
  s.close();
});

test('kill blocks starts and all delivery, survives restart, and clear never revives old runs', async () => {
  const path = file(); let s = new Store(path); ready(s);
  new Worker(s, new Waiting(s)).reconcile();
  const [run] = rows(s);
  await main(['kill', 'set'], { SSS_DB: path }, () => {});
  assert.equal(statSync(`${path}.kill`).mode & 0o077, 0);
  assert.throws(() => new Worker(s).deliver(run.id, 'late'), /refused/);
  assert.throws(() => put(s, 'i', 'charged', run.gateway_actor,
    { approval: 1, spec_hash: run.spec_hash, usd: 0 }), /kill/);
  // An unmanaged manual delivery also goes through the kill gate.
  s.registerToken('manual', { kind: 'run', item: 'i' });
  assert.throws(() => put(s, 'i', 'tried', 'manual',
    { approval: 1, spec_hash: run.spec_hash, artifact_hash: 'x' }), /kill/);
  s.close(); s = new Store(path);
  assert.equal(killed(s), true);
  ready(s, 'blocked'); new Worker(s).reconcile();
  assert.equal(rows(s).length, 1);
  assert.equal(s.read('i').state, 'SPECCED');
  assert.equal(s.events('i').at(-1).type, 'failed');
  await main(['kill', 'clear'], { SSS_DB: path }, () => {});
  assert.equal(killed(s), false);
  assert.throws(() => new Worker(s).deliver(run.id, 'resurrect'), /refused/);
  assert.deepEqual(s.db.prepare('SELECT action FROM worker_history').all().map(r => r.action), ['kill.set', 'kill.clear']);
  new Worker(s).reconcile();
  assert.equal(rows(s).filter(r => r.item === 'i').length, 1);
  assert.ok(s.verifyAll().every(r => r.ok));
  s.close();
});

test('independent latch alone and unreadable latch fail closed', () => {
  const path = file(); const s = new Store(path); ready(s);
  writeFileSync(`${path}.kill`, 'stop', { mode: 0o600 });
  new Worker(s).reconcile(); assert.equal(rows(s).length, 0);
  rmSync(`${path}.kill`); mkdirSync(`${path}.kill`);
  assert.equal(killed(s), true);
  new Worker(s).reconcile(); assert.equal(rows(s).length, 0);
  s.close();
});

const storeModule = new URL('../core/store.js', import.meta.url).href;
const runnerModule = new URL('../worker/runner.js', import.meta.url).href;
const fakeModule = new URL('../worker/fake.js', import.meta.url).href;
const imports = `import {Store} from '${storeModule}';import {Worker} from '${runnerModule}';
  import {FakeAdapter} from '${fakeModule}';const s=new Store(process.argv[1]);`;
function child(path, code) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', imports + code, path],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  p.stderr.on('data', bytes => { errors += bytes; });
  const done = new Promise((resolve, reject) => {
    p.on('error', reject); p.on('close', (code, signal) => resolve({ code, signal, errors }));
  });
  return { p, done };
}

test('two real workers race for one logical adapter run and one delivery', async () => {
  const path = file(); const s = new Store(path); ready(s);
  const code = 'new Worker(s).reconcile();s.close();';
  const a = child(path, code); const b = child(path, code);
  const results = await Promise.all([a.done, b.done]);
  for (const result of results) assert.equal(result.code, 0, result.errors);
  assert.equal(rows(s).length, 1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM fake_jobs').get().n, 1);
  assert.equal(s.events('i').filter(e => e.type === 'tried').length, 1);
  assert.ok(s.verifyAll().every(r => r.ok)); s.close();
});

test('worker SIGKILL mid-run resumes the same adapter identity on restart', async () => {
  const path = file(); const s = new Store(path); ready(s);
  const run = child(path, `class Wait extends FakeAdapter {status(){return {state:'running'}}}
    new Worker(s,new Wait(s)).reconcile();process.kill(process.pid,'SIGKILL');`);
  assert.equal((await run.done).signal, 'SIGKILL');
  const id = rows(s)[0].id;
  new Worker(s).reconcile(); new Worker(s).reconcile();
  assert.equal(rows(s).length, 1); assert.equal(rows(s)[0].id, id);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM fake_jobs').get().n, 1);
  assert.equal(s.read('i').state, 'TRYING');
  assert.ok(s.verifyAll().every(r => r.ok)); s.close();
});

test('crash inside adapter start rolls back receipt and artifact together', async () => {
  const path = file(); const s = new Store(path); ready(s);
  const run = child(path, `class Crash extends FakeAdapter {
    start(r){super.start(r);process.kill(process.pid,'SIGKILL');}}
    new Worker(s,new Crash(s)).reconcile();`);
  assert.equal((await run.done).signal, 'SIGKILL');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM fake_jobs').get().n, 0);
  assert.equal(rows(s).length, 1);
  new Worker(s).reconcile();
  assert.equal(s.read('i').state, 'TRYING');
  assert.equal(rows(s).length, 1); s.close();
});


test('pending stop stays pending, and a cleared database latch alone still blocks starts', () => {
  const s = new Store(); ready(s);
  const adapter = new Waiting(s); const w = new Worker(s, adapter); w.reconcile();
  setKill(s, true);
  adapter.stop = () => ({ state: 'running' });
  w.reconcile(); assert.equal(rows(s)[0].status, 'stop_requested');
  assert.equal(s.read('i').state, 'SENDING');
  w.adapter = new FakeAdapter(s); w.reconcile();
  assert.equal(rows(s)[0].status, 'stopped');
  ready(s, 'second'); w.reconcile();
  assert.equal(rows(s).length, 1);
  s.close();
});


test('CLI one-pass worker and explicit kill status have no web admin dependency', async () => {
  const path = file(); const s = new Store(path); ready(s);
  const output = [];
  await main(['kill', 'status'], { SSS_DB: path }, value => output.push(value));
  assert.deepEqual(output, ['clear']);
  await main(['worker', '--once'], { SSS_DB: path }, () => {});
  assert.equal(s.read('i').state, 'TRYING');
  await main(['kill', 'set'], { SSS_DB: path }, () => {});
  await main(['kill', 'status'], { SSS_DB: path }, value => output.push(value));
  assert.deepEqual(output, ['clear', 'stopped']);
  s.close();
});
