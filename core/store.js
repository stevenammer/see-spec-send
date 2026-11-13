import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fold, initial, step } from './machine.js';
import { attach, guard } from '../worker/control.js';
import { migrate } from './migrations.js';
import { invalid, refused } from './errors.js';
import { appendAudit } from './audit.js';

const digest = value => createHash('sha256').update(value).digest('hex');
// Fixed page size for the feed and the item API. There is no setting for it.
export const PAGE_SIZE = 50;
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  // Match JSON's treatment of absent values. Direct callers can build an event
  // object with an optional field set to `undefined`; persisting that literal
  // would make the derived context unreadable on its next replay.
  if (Array.isArray(value)) return `[${value.map(entry => stable(entry) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().flatMap(key => {
    const entry = stable(value[key]);
    return entry === undefined ? [] : [`${JSON.stringify(key)}:${entry}`];
  }).join(',')}}`;
};
const eventHash = (prev, seq, type, actor, bodyHash, at, authority) => {
  const event = { prev, seq, type, actor, bodyHash, at };
  if (authority) {
    event.actor_kind = authority.kind;
    event.actor_leader = authority.leader ? 1 : 0;
  }
  return digest(stable(event));
};
const scopedBodyHash = (item, bytes) => digest(`${item}\0${bytes}`);
// The idempotency key is part of the hash so a forged key is caught by verify.
const submittedEventHash = (event, idem) => digest(stable({ idem, event }));

function bodyOf(event) {
  const body = { ...event };
  delete body.type;
  delete body.actor;
  delete body.at;
  return body;
}

function erasedText(value) {
  return Array.isArray(value) ? value.map(() => '[erased]') : '[erased]';
}

function redactBody(type, body) {
  const tombstone = {};
  const structural = ['verdict', 'quorum', 'cap_usd', 'approval', 'spec_hash',
    'artifact_hash', 'usd', 'steward', 'body_hash', 'redacted_hash', 'delivered_by',
    'anchor_kind', 'anchor_hash', 'parent', 'kind', 'base_hash', 'rules', 'source_label', 'honesty_label',
    'see_hash', 'spec_hash', 'packet_hash', 'approval', 'iteration', 'job', 'receipt', 'model', 'mode'];
  const textFields = ['problem', 'looked', 'found', 'must', 'how_we_know', 'out_of_scope',
    'note', 'reason', 'comment', 'original', 'text', 'assumptions', 'open_questions', 'instruction'];
  // Preserve only known machine fields; unknown metadata may contain personal writing.
  for (const field of structural) {
    if (Object.hasOwn(body, field)) tombstone[field] = body[field];
  }
  for (const field of textFields) {
    if (Object.hasOwn(body, field)) tombstone[field] = erasedText(body[field]);
  }
  return tombstone;
}

export class Store {
  // `database` is deliberately a small synchronous compatibility surface
  // (`exec`, `prepare`, and `close`).  It keeps the event-store contract
  // independent of SQLite without making an unreviewed network client the
  // default runtime.
  constructor(file = ':memory:', { database, kind = 'sqlite', busyMs = 5000 } = {}) {
    if (!Number.isSafeInteger(busyMs) || busyMs < 0 || busyMs > 60_000) throw new Error('busy timeout out of range');
    if (!database && file !== ':memory:' && file !== '') {
      // The database holds event bodies and token digests: owner-only from the first byte.
      closeSync(openSync(file, 'a', 0o600));
      chmodSync(file, 0o600);
    }
    this.kind = kind;
    this.db = database || new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA busy_timeout=${busyMs}; PRAGMA journal_mode=WAL;`);
      // Schema, backfills and the version check all live in core/migrations.js.
      migrate(this, database ? '' : file);
    } catch (error) {
      if (!database) this.db.close();
      throw error;
    }
    attach(this, file);
  }

  migrateActorKinds() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='actors'").get()?.sql || '';
    if (schema.includes("'source'")) return;
    // SQLite cannot alter a CHECK constraint. Keep the registry bytes intact while
    // adding the deliberately non-person integration source kind. Runs in the migration transaction.
    this.db.exec(`ALTER TABLE actors RENAME TO actors_legacy_kind;
      CREATE TABLE actors(id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run','source')),
        leader INTEGER DEFAULT 0, item TEXT NULL);
      INSERT INTO actors(id,kind,leader,item) SELECT id,kind,leader,item FROM actors_legacy_kind;
      DROP TABLE actors_legacy_kind;`);
  }

  migrateF1() {
    const effort = this.db.prepare("SELECT kind FROM actors WHERE id='effort'").get();
    if (effort?.kind === 'person') throw new Error('cannot migrate: person account effort is reserved for Effort (AI)');
    const actorsSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='actors'").get()?.sql || '';
    if (!actorsSql.includes("'agent'")) {
      this.db.exec(`ALTER TABLE actors RENAME TO actors_before_f1;
        CREATE TABLE actors(id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run','source','agent')),
          leader INTEGER DEFAULT 0, item TEXT NULL);
        INSERT INTO actors(id,kind,leader,item) SELECT id,kind,leader,item FROM actors_before_f1;
        DROP TABLE actors_before_f1;`);
    }
    this.db.prepare("INSERT OR IGNORE INTO actors(id,kind,leader,item) VALUES('effort','agent',0,NULL)").run();
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all().map(row => row.name);
    if (!runColumns.includes('iteration')) {
      this.db.exec(`ALTER TABLE runs RENAME TO runs_before_f1;
        CREATE TABLE runs(
          id TEXT PRIMARY KEY, item TEXT NOT NULL, approval INTEGER NOT NULL, iteration INTEGER NOT NULL DEFAULT 0,
          spec_hash TEXT NOT NULL, run_actor TEXT UNIQUE NOT NULL, gateway_actor TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, started_at INTEGER,
          UNIQUE(item,approval,iteration)
        );
        INSERT INTO runs(id,item,approval,iteration,spec_hash,run_actor,gateway_actor,status,delivered,started_at)
          SELECT id,item,approval,0,spec_hash,run_actor,gateway_actor,status,delivered,started_at FROM runs_before_f1;
        DROP TABLE runs_before_f1;`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS effort_jobs(
      id TEXT PRIMARY KEY, item TEXT NOT NULL, kind TEXT NOT NULL, trigger_seq INTEGER NOT NULL,
      requester TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER, last_error TEXT, created INTEGER NOT NULL, UNIQUE(item,kind,trigger_seq)
    );
    CREATE TABLE IF NOT EXISTS gateway_effort_receipts(
      id TEXT PRIMARY KEY, person TEXT NOT NULL, idem TEXT NOT NULL, payload_hash TEXT NOT NULL,
      policy TEXT NOT NULL, day TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
      worst_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, state TEXT NOT NULL,
      usage TEXT, outcome TEXT, seal TEXT NOT NULL, item TEXT NOT NULL, job TEXT NOT NULL,
      UNIQUE(person,idem)
    );`);
  }

  // Runs as the authority migration step on every upgrade. The runner holds the transaction,
  // so any throw here rolls the whole upgrade back.
  backfillAuthoritySnapshots() {
    const rows = this.db.prepare(`SELECT * FROM events
      WHERE (authority_version=0 OR authority_version IS NULL)
      AND (actor_kind IS NULL OR actor_leader IS NULL)`).all();
    const actor = this.db.prepare('SELECT kind,leader FROM actors WHERE id=?');
    const fillSnapshots = this.db.prepare(`UPDATE events
      SET actor_kind=?, actor_leader=?, authority_version=0 WHERE item=? AND seq=?`);
    try {
      // Legacy hashes cannot recover past roles. Capture today's registry once.
      for (const row of rows) {
        const snapshot = actor.get(row.actor);
        if (!snapshot) throw new Error('legacy authority migration requires a known actor');
        fillSnapshots.run(snapshot.kind, snapshot.leader, row.item, row.seq);
      }
      for (const { item } of this.db.prepare('SELECT DISTINCT item FROM events').all()) {
        if (!this.verify(item).ok) throw new Error('legacy migration found an invalid chain');
      }
      // The machine now records past shapers, and releases change item contexts. Refresh the
      // derived cache from events on every upgrade, including databases with no legacy rows.
      this.rebuild();
    } catch (error) {
      throw new Error(`authority migration failed: ${error.message}`, { cause: error });
    }
  }

  backfillSubmittedHashes() {
    const rows = this.db.prepare(`SELECT e.* FROM events e
      JOIN bodies b ON b.hash=e.body_hash WHERE e.submitted_hash IS NULL`).all();
    const fill = this.db.prepare('UPDATE events SET submitted_hash=? WHERE item=? AND seq=?');
    for (const row of rows) fill.run(submittedEventHash(this.submittedEventFromRow(row), row.idem), row.item, row.seq);
  }

  registerPerson(id, { leader = false } = {}) {
    if (!id) throw new Error('person id required');
    const existing = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(id);
    if (existing && existing.kind !== 'person') throw new Error('actor kind cannot change');
    this.db.prepare(`INSERT INTO actors(id,kind,leader,item) VALUES(?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET leader=excluded.leader, item=NULL`)
      .run(id, 'person', leader ? 1 : 0);
  }

  registerToken(id, { kind, item } = {}) {
    if (!id || !['gateway', 'run'].includes(kind) || !item) {
      throw new Error('token id, kind, and item required');
    }
    const existing = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(id);
    if (existing && existing.kind !== kind) throw new Error('actor kind cannot change');
    this.db.prepare(`INSERT INTO actors(id,kind,leader,item) VALUES(?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET leader=0, item=excluded.item`)
      .run(id, kind, item);
  }

  registerSource(id) {
    if (!id) throw new Error('source id required');
    const existing = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(id);
    if (existing && existing.kind !== 'source') throw new Error('actor kind cannot change');
    this.db.prepare(`INSERT INTO actors(id,kind,leader,item) VALUES(?, 'source', 0, NULL)
      ON CONFLICT(id) DO UPDATE SET leader=0, item=NULL`).run(id);
  }

  actor(id, item) {
    const row = this.db.prepare('SELECT id,kind,leader,item FROM actors WHERE id=?').get(id);
    if (!row) throw invalid('unknown actor');
    if (!['person', 'source', 'agent'].includes(row.kind) && row.item !== item) throw invalid('token is scoped to another item');
    return { kind: row.kind, leader: row.leader === 1 };
  }

  eventRows(item) {
    return this.db.prepare('SELECT * FROM events WHERE item=? ORDER BY seq').all(item);
  }

  eventFromRow(row) {
    const bytes = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash)?.bytes;
    return { ...(bytes ? JSON.parse(bytes) : {}), type: row.type, actor: row.actor,
      body_hash: row.body_hash, at: row.at };
  }

  submittedEventFromRow(row) {
    const bytes = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash)?.bytes;
    if (!bytes) return null;
    return { ...JSON.parse(bytes), type: row.type, actor: row.actor, at: row.at };
  }

  events(item) { return this.eventRows(item).map(row => this.eventFromRow(row)); }

  authorityFromRow(row) {
    return { kind: row.actor_kind, leader: row.actor_leader === 1 };
  }

  replay(item) {
    const rows = this.eventRows(item);
    const events = rows.map(row => ({ ...this.eventFromRow(row), authority: this.authorityFromRow(row) }));
    return fold(events, (actor, event) => event.authority);
  }

  putArtifact(item, html) {
    if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 256 * 1024) {
      throw refused('artifact too large');
    }
    const hash = scopedBodyHash(item, html);
    this.db.prepare('INSERT OR IGNORE INTO bodies(hash,bytes) VALUES(?,?)').run(hash, html);
    return hash;
  }

  artifact(item, hash) {
    const row = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(hash);
    if (!row || scopedBodyHash(item, row.bytes) !== hash) return null;
    return row.bytes;
  }

  // One fixed-size page, keyed by item ID. `next` is the cursor for the following page, or null.
  listPage(after = '') {
    const rows = this.db.prepare('SELECT item,state,context FROM items WHERE item > ? ORDER BY item LIMIT ?')
      .all(String(after), PAGE_SIZE + 1);
    const items = rows.slice(0, PAGE_SIZE).map(row => {
      const context = JSON.parse(row.context);
      const first = this.eventFromRow(this.eventRows(row.item)[0]);
      return { id: row.item, state: row.state, problem: first?.original || first?.problem || '', steward: context.steward,
        spent: context.spentMicros / 1_000_000, quorum: context.quorum, helpers: context.helpers.length };
    });
    return { items, next: rows.length > PAGE_SIZE ? items.at(-1).id : null };
  }

  listItems() { return this.listPage().items; }

  eventCount(item) {
    return Number(this.db.prepare('SELECT count(*) AS n FROM events WHERE item=?').get(item).n);
  }

  commentCount(item) {
    return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE item=? AND type='commented'").get(item).n);
  }

  stateEventCount(item) {
    return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE item=? AND type<>'commented'").get(item).n);
  }

  eventCapReached(item, type) {
    return type === 'commented' ? this.commentCount(item) >= 1000 : this.stateEventCount(item) >= 200;
  }

  read(item) { return this.replay(item); }

  cache(item) {
    const row = this.db.prepare('SELECT context FROM items WHERE item=?').get(item);
    return row?.context ? JSON.parse(row.context) : initial();
  }

  ensureEvent(item, event) {
    if (!item || !event?.type || !event.actor) throw refused('item, event, and actor required');
    if (Object.hasOwn(event, 'role')) throw refused('event role is forbidden');
    if (typeof event.at !== 'string' || !event.at) throw refused('event.at required');
    this.actor(event.actor, item);
    if (event.type === 'steward_changed') {
      const next = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(event.steward);
      if (!next || next.kind !== 'person') throw invalid('steward must be a registered person');
    }
    if (event.type === 'posted' && this.eventRows(item).length !== 0) throw refused('posted event requires a fresh item');
    if (event.type === 'forked') {
      if (this.eventRows(item).length !== 0) throw refused('forked event requires a fresh item');
      const parent = event.parent;
      const row = parent && typeof parent.item === 'string' && Number.isInteger(parent.seq)
        ? this.db.prepare('SELECT hash FROM events WHERE item=? AND seq=?').get(parent.item, parent.seq)
        : null;
      if (!row || row.hash !== parent.hash) throw refused('fork parent does not match');
    }
    if (event.type === 'commented' && event.parent !== undefined) {
      const parent = this.db.prepare(`SELECT b.bytes FROM events e JOIN bodies b ON b.hash=e.body_hash
        WHERE e.item=? AND e.body_hash=? AND e.type='commented'`).get(item, event.parent);
      if (!parent) throw refused('parent must be a comment in this item');
      let body;
      try { body = JSON.parse(parent.bytes); } catch { throw refused('parent is invalid'); }
      if (body.anchor_kind !== event.anchor_kind) throw refused('parent anchor does not match');
    }
    const comment = hash => this.db.prepare(`SELECT b.bytes,b.erased FROM events e JOIN bodies b ON b.hash=e.body_hash
      WHERE e.item=? AND e.body_hash=? AND e.type='commented'`).get(item, hash);
    if (event.type === 'revised' && Array.isArray(event.credits)) for (const credit of event.credits) {
      const row = comment(credit?.comment);
      if (!row || row.erased) throw refused('credit must reference an unerased comment in this item');
      const body = JSON.parse(row.bytes);
      if (credit.mode === 'quoted' && (!event.text.includes(body.comment) || !body.comment.includes(credit.quote || body.comment)))
        throw refused('quoted credit must be verbatim in the comment and revision');
    }
    if (event.type === 'steered' && event.source) {
      const row = comment(event.source);
      if (!row || row.erased) throw refused('steer source must be an unerased comment in this item');
      if (event.mode === 'quoted' && !event.instruction.includes(JSON.parse(row.bytes).comment)) throw refused('quoted steer must be verbatim');
    }
    if (event.type === 'sent') {
      const packet = this.artifact(item, event.packet_hash);
      let data; try { data = packet && JSON.parse(packet); } catch { data = null; }
      if (!data || data.specHash !== event.spec_hash) throw refused('sent packet must exist and bind the spec hash');
    }
  }

  append(item, event, options = {}) {
    if (!options.idem) throw invalid('idem required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const answer = this.appendInTransaction(item, event, options);
      this.db.exec('COMMIT');
      return answer;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  appendInTransaction(item, event, options) {
    const { expectedSeq, idem, authoritySnapshot, authorityVersion = 1, bodyHash } = options;
    const submittedHash = submittedEventHash(event, idem);
    const existing = this.db.prepare('SELECT * FROM events WHERE item=? AND idem=?').get(item, idem);
    if (existing) {
      const storedEvent = this.submittedEventFromRow(existing);
      const existingHash = existing.submitted_hash || (storedEvent && submittedEventHash(storedEvent, existing.idem));
      if (!existingHash) throw invalid('idempotency record cannot be compared');
      if (existingHash !== submittedHash) {
        throw refused('idempotency key reused with a different event');
      }
      if (!existing.submitted_hash) {
        this.db.prepare('UPDATE events SET submitted_hash=? WHERE item=? AND seq=?')
          .run(existingHash, item, existing.seq);
      }
      return { idempotent: true, seq: existing.seq, ...this.read(item) };
    }
    this.ensureEvent(item, event);
    if (this.eventCapReached(item, event.type)) throw refused('item is full');
    guard(this, item, event);
    const cached = this.db.prepare('SELECT * FROM items WHERE item=?').get(item);
    const currentSeq = cached?.seq || 0;
    if (expectedSeq !== undefined && expectedSeq !== currentSeq) throw refused('stale expectedSeq');
    const bytes = stable(bodyOf(event));
    const hashOfBody = bodyHash || scopedBodyHash(item, bytes);
    const prior = this.read(item);
    if (prior.refusal) throw refused(`cannot append: replay refused: ${prior.refusal}`);
    const authority = authoritySnapshot || this.actor(event.actor, item);
    const outcome = step(prior.context, { ...event, body_hash: hashOfBody }, authority);
    if (outcome.refusal) throw refused(outcome.refusal);
    const seq = currentSeq + 1;
    const previous = cached?.head || '';
    const hash = eventHash(previous, seq, event.type, event.actor, hashOfBody, event.at,
      authorityVersion === 1 ? authority : null);
    this.db.prepare('INSERT OR IGNORE INTO bodies(hash,bytes) VALUES(?,?)').run(hashOfBody, bytes);
    this.db.prepare(`INSERT INTO events(item,seq,type,actor,body_hash,prev_hash,hash,at,idem,
      submitted_hash,actor_kind,actor_leader,authority_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(item, seq, event.type, event.actor, hashOfBody, previous, hash, event.at, idem,
        submittedHash, authority.kind, authority.leader ? 1 : 0, authorityVersion);
    this.db.prepare(`INSERT INTO items(item,state,head,seq,context) VALUES(?,?,?,?,?)
      ON CONFLICT(item) DO UPDATE SET state=excluded.state,head=excluded.head,
      seq=excluded.seq,context=excluded.context`)
      .run(item, outcome.state, hash, seq, stable(outcome.context));
    this.enqueueIntegrationOutbox(item, event, outcome.state, seq);
    if (outcome.effects.some(effect => effect.kind === 'build.stop')) {
      this.db.prepare("UPDATE runs SET status='stop_requested' WHERE item=? AND approval=? AND status='active'")
        .run(item, prior.context.approval);
    }
    return { seq, hash, ...this.read(item), effects: outcome.effects };
  }

  // These rows are deliberately written before the event transaction commits. A
  // process can die after commit, but it cannot leave a delivered event without a
  // durable delivery record for a configured destination.
  enqueueIntegrationOutbox(item, event, stage, seq) {
    const destinations = this.db.prepare('SELECT name,include_text FROM integration_destinations WHERE enabled=1').all();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created)
      VALUES(?,?,?,?,?,?, 'pending',0,?,?)`);
    for (const destination of destinations) {
      const payload = { item_id: item, stage, event_type: event.type, link: `/items/${encodeURIComponent(item)}` };
      const text = event.problem || event.note || event.comment;
      if (destination.include_text && typeof text === 'string') payload.text = text;
      const created = new Date(event.at).getTime();
      if (!Number.isSafeInteger(created)) throw new Error('event timestamp is invalid');
      insert.run(destination.name, item, seq, event.type, stage, stable(payload), created, created);
    }
  }

  verify(item) {
    const rows = this.eventRows(item);
    const erased = new Map();
    for (const row of rows.filter(row => row.type === 'erased')) {
      const bytes = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(row.body_hash)?.bytes;
      if (!bytes) continue;
      let receipt;
      try { receipt = JSON.parse(bytes); } catch {
        return { ok: false, seq: row.seq, reason: 'body' };
      }
      erased.set(receipt.body_hash, receipt.redacted_hash);
    }
    let previous = '';
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.seq !== index + 1) return { ok: false, seq: row.seq, reason: 'sequence' };
      const body = this.db.prepare('SELECT bytes,erased FROM bodies WHERE hash=?').get(row.body_hash);
      if (body && body.erased !== 1 && scopedBodyHash(item, body.bytes) !== row.body_hash) {
        return { ok: false, seq: row.seq, reason: 'body' };
      }
      // The sealed receipt binds the replacement bytes as well as the original body hash.
      if (body?.erased === 1
          && erased.get(row.body_hash) !== scopedBodyHash(item, body.bytes)) {
        return { ok: false, seq: row.seq, reason: 'erasure' };
      }
      if (!body && !erased.has(row.body_hash)) return { ok: false, seq: row.seq, reason: 'body' };
      // An erased body cannot be re-hashed, but its receipt is in the chain.
      if (body && body.erased !== 1
          && submittedEventHash(this.submittedEventFromRow(row), row.idem) !== row.submitted_hash) {
        return { ok: false, seq: row.seq, reason: 'submission' };
      }
      const authority = row.authority_version === 1
        ? { kind: row.actor_kind, leader: row.actor_leader === 1 }
        : null;
      const hash = eventHash(previous, row.seq, row.type, row.actor, row.body_hash, row.at, authority);
      if (row.prev_hash !== previous || row.hash !== hash) {
        return { ok: false, seq: row.seq, reason: 'chain' };
      }
      previous = row.hash;
    }
    return { ok: true };
  }

  // Every item that has events or a cache row: orphaned events cannot hide, and the
  // cache must equal a full replay.
  verifyAll() {
    const names = new Set([
      ...this.db.prepare('SELECT DISTINCT item FROM events').all().map(row => row.item),
      ...this.db.prepare('SELECT item FROM items').all().map(row => row.item),
    ]);
    return [...names].sort().map(item => {
      const chain = this.verify(item);
      if (!chain.ok) return { item, ...chain };
      const cache = this.db.prepare('SELECT * FROM items WHERE item=?').get(item);
      if (!cache) return { item, ok: false, reason: 'cache-missing' };
      const replay = this.read(item);
      if (replay.refusal) return { item, ok: false, reason: 'state' };
      const last = this.eventRows(item).at(-1);
      const same = cache.head === (last?.hash || '') && cache.seq === (last?.seq || 0)
        && cache.state === replay.state && cache.context === stable(replay.context);
      return same ? { item, ok: true } : { item, ok: false, reason: 'cache' };
    });
  }

  rebuild() {
    this.db.exec('DELETE FROM items');
    for (const { item } of this.db.prepare('SELECT DISTINCT item FROM events').all()) {
      const outcome = this.read(item);
      if (outcome.refusal) throw new Error(`cannot rebuild: replay refused: ${outcome.refusal}`);
      const last = this.eventRows(item).at(-1);
      this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?)').run(
        item, outcome.state, last?.hash || '', last?.seq || 0, stable(outcome.context),
      );
    }
  }

  erase(item, targetHash, actor, at) {
    if (!targetHash || !actor || typeof at !== 'string' || !at) throw new Error('erase arguments required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const target = this.db.prepare('SELECT * FROM events WHERE item=? AND body_hash=?').get(item, targetHash);
      if (!target) throw new Error('body is not part of item');
      const current = this.db.prepare('SELECT seq FROM items WHERE item=?').get(item);
      const body = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(targetHash);
      if (!body) throw new Error('body is already erased');
      const tombstone = stable(redactBody(target.type, JSON.parse(body.bytes)));
      const redacted_hash = scopedBodyHash(item, tombstone);
      this.appendInTransaction(item, { type: 'erased', actor, body_hash: targetHash,
        redacted_hash, at }, {
        expectedSeq: current?.seq || 0, idem: `erase:${targetHash}`,
      });
      // Keep machine fields so an erasure cannot corrupt item history.
      this.db.prepare('UPDATE bodies SET bytes=?, erased=1 WHERE hash=?').run(tombstone, targetHash);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  exportJsonl() {
    const rows = this.db.prepare(`SELECT e.*,b.bytes,b.erased FROM events e LEFT JOIN bodies b ON b.hash=e.body_hash
      ORDER BY e.item,e.seq`).all();
    const actors = this.db.prepare('SELECT id,kind,leader,item FROM actors ORDER BY id').all();
    const lines = actors.map(row => JSON.stringify({ registry: row }));
    lines.push(...rows.map(row => JSON.stringify(row)));
    lines.push(JSON.stringify({ complete: true, events: rows.length, actors: actors.length }));
    return `${lines.join('\n')}\n`;
  }

  importJsonl(text) {
    const lines = text.trim() ? text.trim().split('\n').map(JSON.parse) : [];
    const footer = lines.pop();
    const actors = lines.filter(row => row.registry).map(row => row.registry);
    const events = lines.filter(row => !row.registry);
    if (!footer?.complete || footer.events !== events.length || footer.actors !== actors.length) {
      throw new Error('incomplete import');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const actor of actors) this.importActor(actor);
      for (const row of events) this.importRow(row, events);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  importActor(actor) {
    if (!actor.id || !['person', 'gateway', 'run', 'source', 'agent'].includes(actor.kind)) {
      throw new Error('bad import actor');
    }
    if (!['person', 'source', 'agent'].includes(actor.kind) && !actor.item) throw new Error('bad import actor');
    this.db.prepare(`INSERT INTO actors(id,kind,leader,item) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, leader=excluded.leader, item=excluded.item`)
      .run(actor.id, actor.kind, actor.leader ? 1 : 0, actor.item || null);
  }

  importRow(row, allRows = [row]) {
    const erased = row.erased === 1;
    const hasReceipt = allRows.some(record => record.type === 'erased'
      && record.item === row.item && record.bytes
      && JSON.parse(record.bytes).body_hash === row.body_hash
      && JSON.parse(record.bytes).redacted_hash === scopedBodyHash(row.item, row.bytes));
    if (!row.bytes || (!erased && scopedBodyHash(row.item, row.bytes) !== row.body_hash)) {
      throw new Error('bad import body');
    }
    if (erased && !hasReceipt) throw new Error('erased import body lacks receipt');
    const authority = row.authority_version === 1
      ? { kind: row.actor_kind, leader: row.actor_leader === 1 }
      : null;
    if (eventHash(row.prev_hash, row.seq, row.type, row.actor, row.body_hash, row.at, authority) !== row.hash) {
      throw new Error('bad import chain');
    }
    const existing = this.db.prepare('SELECT * FROM events WHERE item=? AND idem=?').get(row.item, row.idem);
    if (existing) {
      const { bytes, erased: incomingErased, submitted_hash: incomingSubmittedHash, ...stored } = row;
      const { submitted_hash: existingSubmittedHash, ...incoming } = existing;
      const hash = incomingSubmittedHash || submittedEventHash({ ...JSON.parse(row.bytes), type: row.type, actor: row.actor, at: row.at }, row.idem);
      if (stable(incoming) !== stable(stored) || (existingSubmittedHash && existingSubmittedHash !== hash)) {
        throw new Error('conflicting import');
      }
      return;
    }
    const head = this.db.prepare('SELECT head,seq FROM items WHERE item=?').get(row.item);
    if (row.prev_hash !== (head?.head || '') || row.seq !== (head?.seq || 0) + 1) {
      throw new Error('import is not next in chain');
    }
    const event = { ...JSON.parse(row.bytes), type: row.type, actor: row.actor, at: row.at };
    if (!erased && row.submitted_hash && row.submitted_hash !== submittedEventHash(event, row.idem)) {
      throw new Error('bad import event');
    }
    const snapshot = { kind: row.actor_kind, leader: row.actor_leader === 1 };
    const answer = this.appendInTransaction(row.item, event, {
      expectedSeq: row.seq - 1,
      idem: row.idem,
      authoritySnapshot: snapshot,
      authorityVersion: row.authority_version || 0,
      bodyHash: erased ? row.body_hash : undefined,
    });
    if (answer.hash !== row.hash) throw new Error('import hash differs');
    if (erased) this.db.prepare('UPDATE bodies SET erased=1 WHERE hash=?').run(row.body_hash);
  }

  close() { this.db.close(); }
}
