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
export const fixtureRates = Object.freeze({ model: 'fixture:text-v1', input_micros: 1, output_micros: 2, framing_tokens: 8 });
export function priceRate({ model, inputMicrosPerMillion, outputMicrosPerMillion, framingTokens = 0 }) {
  demand(typeof model === 'string' && model.length > 0, 'priced model required');
  demand(integer(inputMicrosPerMillion) && integer(outputMicrosPerMillion) && integer(framingTokens), 'invalid provider price');
  return Object.freeze({ model, input_micros_per_million: inputMicrosPerMillion,
    output_micros_per_million: outputMicrosPerMillion, framing_tokens: framingTokens });
}
const rateCost = (rate, input, output) => {
  if (Number.isSafeInteger(rate.input_micros)) return add(multiply(input, rate.input_micros), multiply(output, rate.output_micros));
  const numerator = add(multiply(input, rate.input_micros_per_million), multiply(output, rate.output_micros_per_million));
  return Math.ceil(numerator / 1_000_000);
};
const validRate = rate => rate && typeof rate.model === 'string' && integer(rate.framing_tokens)
  && ((integer(rate.input_micros) && integer(rate.output_micros))
    || (integer(rate.input_micros_per_million) && integer(rate.output_micros_per_million)));
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
  constructor(store, { clock = Date.now, rate = fixtureRates } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    demand(validRate(rate), 'invalid gateway rate');
    this.rate = Object.freeze({ ...rate });
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
      this.db.prepare('INSERT INTO gateway_policy_versions VALUES(1,?,?)').run(bytes, digest(bytes));
    });
  }

  setPolicy(policy) {
    validatePolicy(policy);
    return transaction(this.store, () => {
      const current = this.db.prepare('SELECT * FROM gateway_policy WHERE id=1').get();
      demand(current && current.seal === digest(current.bytes), 'gateway policy is not configured or corrupt');
      const bytes = canonical(policy); const seal = digest(bytes);
      const version = this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM gateway_policy_versions').get().version;
      this.db.prepare('INSERT INTO gateway_policy_versions VALUES(?,?,?)').run(version, bytes, seal);
      this.db.prepare('UPDATE gateway_policy SET bytes=?,seal=? WHERE id=1').run(bytes, seal);
      return version;
    });
  }

  policyVersions() {
    return this.db.prepare('SELECT * FROM gateway_policy_versions ORDER BY version').all().map(row => {
      demand(row.seal === digest(row.bytes), 'corrupt gateway policy version');
      const policy = JSON.parse(row.bytes); validatePolicy(policy); return { version: row.version, policy };
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
    demand(input.model === this.rate.model, 'model has no reviewed price');
    demand(typeof input.input === 'string' && Buffer.byteLength(input.input) <= policy.input_bytes, 'input byte limit');
    demand(integer(input.max_output_tokens, policy.output_tokens) && input.max_output_tokens > 0, 'output token limit');
    const inputBound = add(Buffer.byteLength(input.input), this.rate.framing_tokens);
    const worst = rateCost(this.rate, inputBound, input.max_output_tokens);
    return { inputBound, worst };
  }

  check(row) {
    demand(row.seal === sealed(row), 'corrupt gateway receipt checksum');
    for (const key of ['cap_micros', 'approval', 'input_bound', 'output_bound', 'worst_micros', 'charged_micros']) {
      demand(integer(row[key]), 'corrupt receipt integer');
    }
    const rate = JSON.parse(row.rate);
    // The receipt seals its own immutable reviewed rate. A later provider
    // configuration change must not make older receipts unverifiable.
    demand(validRate(rate), 'corrupt rate snapshot');
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
    demand(validRate(rate) && row.worst_micros === rateCost(rate, row.input_bound, row.output_bound), 'corrupt reservation amount');
    demand(row.charged_micros <= row.worst_micros, 'corrupt accounting amount');
    demand(['reserved', 'dispatched', 'settled', 'cancelled', 'released'].includes(row.state), 'corrupt receipt state');
    if (['reserved', 'dispatched'].includes(row.state)) {
      demand(row.charged_micros === row.worst_micros && row.usage === null && row.outcome === null, 'corrupt hold');
    } else if (row.state === 'cancelled') {
      demand(row.charged_micros === 0 && row.usage === null && row.outcome === null, 'corrupt cancellation');
    } else if (row.state === 'released') {
      demand(row.usage === null && row.outcome === null, 'corrupt hold release');
      const audit = this.db.prepare("SELECT * FROM gateway_hold_audit WHERE receipt=? AND action='release'").all(row.id);
      demand(audit.length === 1 && audit[0].seal === digest(canonical(Object.fromEntries(Object.entries(audit[0]).filter(([key]) => key !== 'seal')))), 'corrupt hold release audit');
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

  questReceipts() {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_quest_receipts'").get();
    if (!table) return [];
    return this.db.prepare('SELECT * FROM gateway_quest_receipts ORDER BY id').all().map(row => {
      demand(row.seal === sealed(row), 'corrupt Quest receipt');
      demand(['reserved', 'dispatched', 'settled'].includes(row.state), 'corrupt Quest receipt state');
      demand(integer(row.charged_micros) && integer(row.worst_micros) && row.charged_micros <= row.worst_micros,
        'corrupt Quest accounting');
      return row;
    });
  }

  cost(row, usage) {
    demand(usage && canonical(Object.keys(usage).sort()) === canonical(['input_tokens', 'output_tokens']), 'invalid usage keys');
    demand(integer(usage.input_tokens, row.input_bound) && integer(usage.output_tokens, row.output_bound), 'invalid usage');
    const rate = JSON.parse(row.rate);
    return rateCost(rate, usage.input_tokens, usage.output_tokens);
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
      const combined = rows.concat(this.questReceipts());
      demand(add(sum(combined), worst) <= policy.global_micros, 'global cap exceeded');
      demand(add(sum(combined.filter(row => row.day === day)), worst) <= policy.day_micros, 'day cap exceeded');
      demand(rows.filter(row => ['reserved', 'dispatched'].includes(row.state)).length < policy.concurrency,
        'gateway concurrency exceeded');
      const row = {
        id: digest(canonical([run.id, idem])), run: run.id, idem, item: run.item, approval: run.approval,
        spec_hash: run.spec_hash, approval_hash: approved.body_hash, cap_micros: cap,
        payload_hash: payloadHash, rate: canonical(this.rate), policy: canonical(policy), day,
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

  holds() {
    return this.receipts().filter(row => ['reserved', 'dispatched'].includes(row.state));
  }

  holdAudits() {
    return this.db.prepare('SELECT * FROM gateway_hold_audit ORDER BY at,id').all().map(row => {
      const { seal: value, ...body } = row;
      demand(value === digest(canonical(body)), 'corrupt hold audit'); return row;
    });
  }

  releaseHold(id, { actor = 'cli', reason, refund = false, at = this.clock() } = {}) {
    demand(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id), 'invalid hold id');
    demand(typeof actor === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(actor), 'invalid release actor');
    demand(typeof reason === 'string' && reason.length > 0 && reason.length <= 2000, 'release reason required');
    demand(typeof refund === 'boolean' && integer(at), 'invalid hold release');
    return transaction(this.store, () => {
      const row = this.check(this.db.prepare('SELECT * FROM gateway_receipts WHERE id=?').get(id));
      demand(['reserved', 'dispatched'].includes(row.state), 'hold is not releasable');
      const audit = { id: digest(canonical([id, actor, at, reason, refund])), receipt: id, actor, at, action: 'release', refund: refund ? 1 : 0, reason };
      audit.seal = digest(canonical(audit));
      this.db.prepare(`INSERT INTO gateway_hold_audit(${Object.keys(audit).join(',')}) VALUES(${Object.keys(audit).map(() => '?').join(',')})`).run(...Object.values(audit));
      return this.update(row, { state: 'released', charged_micros: refund ? 0 : row.worst_micros });
    });
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

// One verification pass for a whole page of items. Each item gets the same annotation
// meteringSummary would give it, without re-verifying every receipt once per item.
export function meteringSummaries(store, ids) {
  const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='gateway_receipts'").get();
  if (!exists) return new Map(ids.map(id => [id, { basis: 'legacy charged events only; gateway not configured', approvals: [] }]));
  const all = new Ledger(store).summary();
  return new Map(ids.map(id => [id, { ...all, approvals: all.approvals.filter(group => group.item === id) }]));
}
