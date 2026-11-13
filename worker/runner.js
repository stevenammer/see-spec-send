import { createHash, randomBytes } from 'node:crypto';
import { FakeAdapter } from './fake.js';
import { killed, transaction } from './control.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const terminal = state => ['stopped', 'failed'].includes(state);
const current = (context, run) => context.phase === 'SENDING'
  && context.approval === run.approval && context.specHash === run.spec_hash;
const credential = () => randomBytes(32).toString('base64url');

export class Worker {
  constructor(store, adapter = new FakeAdapter(store)) {
    this.store = store;
    this.db = store.db;
    this.adapter = adapter;
  }

  reconcile() {
    this.db.prepare('INSERT INTO worker_heartbeat(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at').run(Date.now());
    transaction(this.store, () => {
      // The item cache names the items in SENDING. Only those are replayed, so an idle item costs nothing.
      for (const { item } of this.db.prepare("SELECT item FROM items WHERE state='SENDING'").all()) {
        if (killed(this.store)) continue;
        const context = this.store.read(item).context;
        if (context.phase !== 'SENDING') continue;
        const id = digest(JSON.stringify([item, context.approval, context.iteration || 0]));
        if (this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id)) continue;
        const runToken = credential();
        const gatewayToken = credential();
        this.store.registerToken(digest(runToken), { kind: 'run', item });
        this.store.registerToken(digest(gatewayToken), { kind: 'gateway', item });
        this.db.prepare('INSERT INTO runs(id,item,approval,iteration,spec_hash,run_actor,gateway_actor,status,delivered,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, item, context.approval, context.iteration || 0, context.specHash, digest(runToken), digest(gatewayToken), 'active', 0, Date.now());
      }
    });
    for (const run of this.db.prepare("SELECT * FROM runs WHERE status!='stopped'").all()) {
      this.advance(run.id);
    }
  }

  advance(id) {
    // No await inside the lock. Later adapters must persist an idempotent request, not wait for a build here.
    let externalRequest;
    transaction(this.store, () => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
      const context = this.store.read(run.item).context;
      if (run.status === 'stopped') return;
      if (run.status !== 'active' || killed(this.store) || !current(context, run)) {
        this.db.prepare("UPDATE runs SET status='stop_requested' WHERE id=?").run(id);
        return;
      }
      const spec = this.store.events(run.item).find(event => event.type === 'specced' && event.body_hash === run.spec_hash);
      if (!spec) throw new Error('approved spec missing');
      const instructions = this.store.events(run.item).filter(event => event.type === 'steered'
        && event.approval === run.approval && event.spec_hash === run.spec_hash)
        .map(event => ({ instruction: event.instruction, actor: event.actor, source: event.source || null, mode: event.mode || null }));
      const request = { id, item: run.item, approval: run.approval, iteration: run.iteration, spec_hash: run.spec_hash, instructions,
        cap_micros: context.capMicros, spec: {
          must: spec.must, how_we_know: spec.how_we_know, out_of_scope: spec.out_of_scope,
        } };
      // External adapters must mint capabilities and start a process after the worker
      // lock is released. The fake stays transactional for its crash-proof contract.
      if (this.adapter.externalStart) externalRequest = request;
      else this.adapter.start(request);
    });
    if (externalRequest) this.adapter.start(externalRequest);
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (run.status === 'stop_requested') return this.stop(run);
    const observed = this.adapter.status(id);
    if (observed.state === 'ready') this.deliver(id, observed.html);
    else if (terminal(observed.state)) this.stop(run);
  }

  deliver(id, html) {
    return transaction(this.store, () => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
      if (!run) throw new Error('unknown run');
      if (run.delivered) return false;
      const context = this.store.read(run.item).context;
      if (run.status !== 'active' || killed(this.store) || !current(context, run)) {
        throw new Error('delivery refused for stopped or stale run');
      }
      const artifact_hash = this.store.putArtifact(run.item, html);
      this.store.appendInTransaction(run.item, { type: 'tried', actor: run.run_actor,
        approval: run.approval, spec_hash: run.spec_hash, artifact_hash, at: new Date().toISOString(),
        iteration: run.iteration,
        model_output: this.adapter.modelOutput === true,
      }, { idem: `run:${id}:tried` });
      this.db.prepare("UPDATE runs SET delivered=1,status='stop_requested' WHERE id=?").run(id);
      return true;
    });
  }

  stop(run) {
    // Intent commits before the adapter call, so a lost response is retried on the next pass.
    transaction(this.store, () => {
      this.db.prepare("UPDATE runs SET status='stop_requested' WHERE id=? AND status='active'").run(run.id);
    });
    const observed = this.adapter.stop(run.id);
    if (!terminal(observed.state)) return;
    transaction(this.store, () => {
      const fresh = this.db.prepare('SELECT * FROM runs WHERE id=?').get(run.id);
      const context = this.store.read(run.item).context;
      if (!fresh.delivered && current(context, run)) {
        this.store.appendInTransaction(run.item, { type: 'failed', actor: run.run_actor,
          approval: run.approval, spec_hash: run.spec_hash, reason: 'worker stopped run',
          iteration: run.iteration,
          at: new Date().toISOString(),
        }, { idem: `run:${run.id}:failed` });
      }
      this.db.prepare("UPDATE runs SET status='stopped' WHERE id=?").run(run.id);
    });
  }
}
