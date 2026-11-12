import { createHash, randomBytes } from 'node:crypto';
import { usdToMicros } from '../core/machine.js';
import { killed, transaction } from '../worker/control.js';

export const canonical = value => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const digest = value => createHash('sha256').update(value).digest('hex');
const integer = (n, ceiling = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= ceiling;
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const add = (a, b) => {
  demand(integer(a) && integer(b) && integer(a + b), 'unsafe accounting integer');
  return a + b;
};
const multiply = (a, b) => {
  demand(integer(a) && integer(b) && integer(a * b), 'unsafe accounting product');
  return a * b;
};
const sealed = row => { const { seal, ...data } = row; return digest(canonical(data)); };
const rates = Object.freeze({ model: 'fixture:text-v1', input_micros: 1, output_micros: 2, framing_tokens: 8 });
export const fixturePolicy = overrides => ({
  enabled: true, global_micros: 1_000_000, day_micros: 100_000, concurrency: 4,
  input_bytes: 8192, output_tokens: 1024, response_bytes: 8192, timeout_ms: 2000, ...overrides,
});
const validatePolicy = policy => {
  const expected = Object.keys(fixturePolicy()).sort();
  demand(canonical(Object.keys(policy).sort()) === canonical(expected), 'invalid gateway policy keys');
  demand(typeof policy.enabled === 'boolean', 'invalid gateway enablement');
  for (const key of ['global_micros', 'day_micros']) demand(integer(policy[key], 1_000_000_000_000), 'invalid cap');
  for (const key of ['input_bytes', 'output_tokens', 'response_bytes', 'timeout_ms']) {
    demand(integer(policy[key], 1_000_000) && policy[key] > 0, 'invalid gateway limit');
  }
  demand(integer(policy.concurrency, 1000) && policy.concurrency > 0, 'invalid concurrency');
};
const live = (store, run) => {
  demand(run && !killed(store) && run.status === 'active', 'stopped run');
  const state = store.read(run.item);
  demand(!state.refusal && state.context.phase === 'SENDING'
    && state.context.approval === run.approval && state.context.specHash === run.spec_hash, 'stale approval');
  demand(store.verify(run.item).ok, 'item verification failed');
  return state.context;
};
const approvalEvent = (store, run) => {
  const event = store.events(run.item).filter(event => event.type === 'approved')[run.approval - 1];
  demand(event && event.spec_hash === run.spec_hash, 'approval metadata missing');
  return event;
};
export function legacyMicros(store, item, approval) {
  let total = 0;
  for (const event of store.events(item)) {
    if (event.type !== 'charged' || event.approval !== approval) continue;
    const value = usdToMicros(event.usd);
    demand(value !== null, 'invalid legacy accounting');
    total = add(total, value);
  }
  return total;
}

export class Ledger {
  constructor(store, { clock = Date.now } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS gateway_policy(id INTEGER PRIMARY KEY CHECK(id=1), bytes TEXT, seal TEXT);
      CREATE TABLE IF NOT EXISTS gateway_capabilities(
        digest TEXT PRIMARY KEY, run TEXT NOT NULL, item TEXT NOT NULL, approval INTEGER NOT NULL,
        spec_hash TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gateway_receipts(
        id TEXT PRIMARY KEY, run TEXT NOT NULL, idem TEXT NOT NULL, item TEXT NOT NULL, approval INTEGER NOT NULL,
        spec_hash TEXT NOT NULL, approval_hash TEXT NOT NULL, cap_micros INTEGER NOT NULL,
        payload_hash TEXT NOT NULL, rate TEXT NOT NULL, policy TEXT NOT NULL, day TEXT NOT NULL,
        input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL, worst_micros INTEGER NOT NULL,
        charged_micros INTEGER NOT NULL, state TEXT NOT NULL, usage TEXT, outcome TEXT, seal TEXT NOT NULL,
        UNIQUE(run,idem));
      CREATE TABLE IF NOT EXISTS gateway_integrity(id INTEGER PRIMARY KEY CHECK(id=1), receipt_count INTEGER NOT NULL);
      INSERT OR IGNORE INTO gateway_integrity SELECT 1,0 WHERE NOT EXISTS(SELECT 1 FROM gateway_receipts);`);
  }

  configure(policy) {
    validatePolicy(policy);
    return transaction(this.store, () => {
      const prior = this.db.prepare('SELECT * FROM gateway_policy WHERE id=1').get();
      const bytes = canonical(policy);
      if (prior) {
        demand(prior.seal === digest(prior.bytes) && prior.bytes === bytes, 'gateway policy already fixed or corrupt');
        return;
      }
      this.db.prepare('INSERT INTO gateway_policy VALUES(1,?,?)').run(bytes, digest(bytes));
    });
  }

  policy() {
    const row = this.db.prepare('SELECT * FROM gateway_policy WHERE id=1').get();
    if (!row) return { ...fixturePolicy(), enabled: false, global_micros: 0, day_micros: 0 };
    demand(row.seal === digest(row.bytes), 'corrupt gateway policy');
    const policy = JSON.parse(row.bytes);
    validatePolicy(policy);
    return policy;
  }

  mint(runId, ttlMs = 15 * 60_000, persist = () => {}) {
    demand(integer(ttlMs, 60 * 60_000) && ttlMs > 0, 'invalid capability lifetime');
    const raw = randomBytes(32).toString('base64url');
    transaction(this.store, () => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
      live(this.store, run);
      const expires = add(this.clock(), ttlMs);
      const rawDigest = digest(raw);
      this.db.prepare('INSERT INTO gateway_capabilities VALUES(?,?,?,?,?,?,0)')
        .run(rawDigest, run.id, run.item, run.approval, run.spec_hash, expires);
      // Keep the adapter's revocation digest in the same transaction as minting.
      persist(rawDigest);
    });
    return raw;
  }

  revokeDigest(value) {
    demand(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid capability digest');
    this.db.prepare('UPDATE gateway_capabilities SET revoked=1 WHERE digest=?').run(value);
  }

  authorize(raw) {
    demand(typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw), 'invalid capability');
    const cap = this.db.prepare('SELECT * FROM gateway_capabilities WHERE digest=?').get(digest(raw));
    demand(cap && cap.revoked === 0 && integer(cap.expires) && cap.expires > this.clock(), 'expired or revoked capability');
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(cap.run);
    demand(run && cap.item === run.item && cap.approval === run.approval && cap.spec_hash === run.spec_hash,
      'capability binding mismatch');
    live(this.store, run);
    return run;
  }

  validateInput(input, policy) {
    demand(input && !Array.isArray(input) && typeof input === 'object', 'invalid payload');
    demand(canonical(Object.keys(input).sort()) === canonical(['input', 'max_output_tokens', 'model']), 'invalid payload keys');
    demand(input.model === rates.model, 'model has no reviewed fixture price');
    demand(typeof input.input === 'string' && Buffer.byteLength(input.input) <= policy.input_bytes, 'input byte limit');
    demand(integer(input.max_output_tokens, policy.output_tokens) && input.max_output_tokens > 0, 'output token limit');
    const inputBound = add(Buffer.byteLength(input.input), rates.framing_tokens);
    const worst = add(multiply(inputBound, rates.input_micros), multiply(input.max_output_tokens, rates.output_micros));
    return { inputBound, worst };
  }

  check(row) {
    demand(row.seal === sealed(row), 'corrupt gateway receipt checksum');
    for (const key of ['cap_micros', 'approval', 'input_bound', 'output_bound', 'worst_micros', 'charged_micros']) {
      demand(integer(row[key]), 'corrupt receipt integer');
    }
    demand(row.rate === canonical(rates), 'corrupt rate snapshot');
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(row.run);
    demand(run && run.item === row.item && run.approval === row.approval && run.spec_hash === row.spec_hash,
      'corrupt receipt run binding');
    const approved = approvalEvent(this.store, run);
    demand(approved.body_hash === row.approval_hash && usdToMicros(approved.cap_usd) === row.cap_micros,
      'corrupt receipt approval binding');
    demand(row.id === digest(canonical([row.run, row.idem])) && /^[a-f0-9]{64}$/.test(row.payload_hash),
      'corrupt receipt identity');
    const policy = JSON.parse(row.policy);
    validatePolicy(policy);
    demand(row.worst_micros === add(multiply(row.input_bound, rates.input_micros),
      multiply(row.output_bound, rates.output_micros)), 'corrupt reservation amount');
    demand(row.charged_micros <= row.worst_micros, 'corrupt accounting amount');
    demand(['reserved', 'dispatched', 'settled', 'cancelled'].includes(row.state), 'corrupt receipt state');
    if (['reserved', 'dispatched'].includes(row.state)) {
      demand(row.charged_micros === row.worst_micros && row.usage === null && row.outcome === null, 'corrupt hold');
    } else if (row.state === 'cancelled') {
      demand(row.charged_micros === 0 && row.usage === null && row.outcome === null, 'corrupt cancellation');
    } else {
      const usage = JSON.parse(row.usage);
      demand(row.charged_micros === this.cost(row, usage), 'corrupt settlement');
      demand(typeof JSON.parse(row.outcome).output === 'string', 'corrupt outcome');
    }
    return row;
  }

  receipts() {
    const rows = this.db.prepare('SELECT * FROM gateway_receipts ORDER BY id').all();
    const integrity = this.db.prepare('SELECT receipt_count FROM gateway_integrity WHERE id=1').get();
    demand(integrity && integer(integrity.receipt_count) && integrity.receipt_count === rows.length,
      'corrupt gateway receipt count');
    return rows.map(row => this.check(row));
  }

  cost(row, usage) {
    demand(usage && canonical(Object.keys(usage).sort()) === canonical(['input_tokens', 'output_tokens']), 'invalid usage keys');
    demand(integer(usage.input_tokens, row.input_bound) && integer(usage.output_tokens, row.output_bound), 'invalid usage');
    return add(multiply(usage.input_tokens, rates.input_micros), multiply(usage.output_tokens, rates.output_micros));
  }

  reserve(raw, idem, input) {
    demand(typeof idem === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(idem), 'invalid idempotency key');
    return transaction(this.store, () => {
      const run = this.authorize(raw);
      const policy = this.policy();
      demand(policy.enabled, 'gateway disabled');
      const { inputBound, worst } = this.validateInput(input, policy);
      const payloadHash = digest(canonical(input));
      const rows = this.receipts();
      const existing = rows.find(row => row.run === run.id && row.idem === idem);
      if (existing) {
        demand(existing.payload_hash === payloadHash, 'idempotency payload conflict');
        return { row: existing, fresh: false };
      }
      const approved = approvalEvent(this.store, run);
      const cap = usdToMicros(approved.cap_usd);
      demand(cap !== null, 'invalid approved cap');
      const day = new Date(this.clock()).toISOString().slice(0, 10);
      const sum = selected => selected.reduce((n, row) => add(n, row.charged_micros), 0);
      const used = add(legacyMicros(this.store, run.item, run.approval),
        sum(rows.filter(row => row.run === run.id)));
      demand(add(used, worst) <= cap, 'run cap exceeded');
      demand(add(sum(rows), worst) <= policy.global_micros, 'global cap exceeded');
      demand(add(sum(rows.filter(row => row.day === day)), worst) <= policy.day_micros, 'day cap exceeded');
      demand(rows.filter(row => ['reserved', 'dispatched'].includes(row.state)).length < policy.concurrency,
        'gateway concurrency exceeded');
      const row = {
        id: digest(canonical([run.id, idem])), run: run.id, idem, item: run.item, approval: run.approval,
        spec_hash: run.spec_hash, approval_hash: approved.body_hash, cap_micros: cap,
        payload_hash: payloadHash, rate: canonical(rates), policy: canonical(policy), day,
        input_bound: inputBound, output_bound: input.max_output_tokens, worst_micros: worst,
        charged_micros: worst, state: 'reserved', usage: null, outcome: null,
      };
      row.seal = sealed(row);
      const keys = Object.keys(row);
      this.db.prepare(`INSERT INTO gateway_receipts(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
        .run(...Object.values(row));
      this.db.prepare('UPDATE gateway_integrity SET receipt_count=receipt_count+1 WHERE id=1').run();
      return { row, fresh: true };
    });
  }

  update(row, changes) {
    const next = { ...row, ...changes };
    next.seal = sealed(next);
    this.db.prepare('UPDATE gateway_receipts SET state=?,charged_micros=?,usage=?,outcome=?,seal=? WHERE id=?')
      .run(next.state, next.charged_micros, next.usage, next.outcome, next.seal, next.id);
    return next;
  }

  dispatch(raw, id) {
    return transaction(this.store, () => {
      const row = this.check(this.db.prepare('SELECT * FROM gateway_receipts WHERE id=?').get(id));
      demand(row.state === 'reserved', 'dispatch already claimed');
      try {
        const run = this.authorize(raw);
        demand(run.id === row.run, 'dispatch binding mismatch');
      } catch (error) {
        // Evidence of no call: only this fresh reserve owner can reach the dispatch seam.
        this.update(row, { state: 'cancelled', charged_micros: 0 });
        return false;
      }
      this.update(row, { state: 'dispatched' });
      return true;
    });
  }

  settle(id, result) {
    return transaction(this.store, () => {
      const row = this.check(this.db.prepare('SELECT * FROM gateway_receipts WHERE id=?').get(id));
      if (row.state !== 'dispatched') return false;
      demand(result && typeof result.output === 'string'
        && Buffer.byteLength(result.output) <= JSON.parse(row.policy).response_bytes, 'invalid provider output');
      const cost = this.cost(row, result.usage);
      // Authority and day are the original receipt, even if its run is now stopped.
      this.update(row, { state: 'settled', charged_micros: cost,
        usage: canonical(result.usage), outcome: canonical({ output: result.output }) });
      return true;
    });
  }

  outcome(id) {
    const row = this.check(this.db.prepare('SELECT * FROM gateway_receipts WHERE id=?').get(id));
    return row.state === 'settled'
      ? { status: 200, body: { id, state: 'settled', output: JSON.parse(row.outcome).output,
        estimated_micros: row.charged_micros } }
      : { status: 202, body: { id, state: row.state, held_micros: row.charged_micros } };
  }

  summary(item) {
    const all = this.receipts();
    const rows = item ? all.filter(row => row.item === item) : all;
    const approvals = new Map();
    for (const row of rows) {
      const key = `${row.item}:${row.approval}`;
      const group = approvals.get(key) || { item: row.item, approval: row.approval, spec_hash: row.spec_hash,
        cap_micros: row.cap_micros, settled_micros: 0, reserved_micros: 0, unknown_micros: 0,
        legacy_event_micros: legacyMicros(this.store, row.item, row.approval) };
      if (row.state === 'settled') group.settled_micros = add(group.settled_micros, row.charged_micros);
      if (row.state === 'reserved') group.reserved_micros = add(group.reserved_micros, row.charged_micros);
      if (row.state === 'dispatched') group.unknown_micros = add(group.unknown_micros, row.charged_micros);
      approvals.set(key, group);
    }
    return { basis: 'fixture price estimates, not provider invoices', enabled: this.policy().enabled,
      policy: this.policy(), approvals: [...approvals.values()] };
  }
}

// Read-only API annotation. Core spentMicros remains the historical charged-event value.
export function meteringSummary(store, item) {
  const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='gateway_receipts'").get();
  if (!exists) return { basis: 'legacy charged events only; gateway not configured', approvals: [] };
  return new Ledger(store).summary(item);
}
