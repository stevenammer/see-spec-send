import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fold, initial, step } from './machine.js';
import { attach, guard } from '../worker/control.js';
import { migrate } from './migrations.js';
import { invalid, refused } from './errors.js';
import { appendAudit } from './audit.js';
import { emptyScope, validScope, withinScope } from './scope.js';
import { initializeMemory, syncMemory, rebuildMemory, verifyMemory, searchMemory, contributionMemory } from './memory.js';
import { initializeMentoring } from './mentoring.js';

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
    'anchor_kind', 'anchor_hash', 'parent', 'kind', 'base_hash', 'rules', 'post_id', 'post_version', 'source_label', 'honesty_label',
    'see_hash', 'spec_hash', 'base_spec_hash', 'packet_hash', 'approval', 'iteration', 'job', 'receipt', 'model', 'mode', 'credits', 'questMemo', 'consent', 'absent', 'ground', 'max_iterations', 'window_minutes', 'restricted_evidence', 'pivot_note', 'from', 'scope', 'person', 'source', 'seed_policy'];
  const textFields = ['problem', 'looked', 'found', 'must', 'how_we_know', 'out_of_scope',
    'note', 'reason', 'comment', 'original', 'text', 'assumptions', 'open_questions', 'instruction'];
  // Preserve only known machine fields; unknown metadata may contain personal writing.
  for (const field of structural) {
    if (Object.hasOwn(body, field)) tombstone[field] = body[field];
  }
  for (const field of textFields) {
    if (Object.hasOwn(body, field)) tombstone[field] = erasedText(body[field]);
  }
  // Handoff reasons must stay long enough to replay their historical rule.
  if (type === 'steward_changed' && Object.hasOwn(body, 'reason')) tombstone.reason = '[erased note]';
  if (type === 'researched') tombstone.sources = Object.fromEntries(Object.entries(body.sources).map(([source, entry]) =>
    [source, { ...entry, finding: entry.status === 'not connected' ? 'nothing checked' : '[erased]' }]));
  if (body.seed_spec) tombstone.seed_spec = { ...body.seed_spec,
    must: erasedText(body.seed_spec.must), how_we_know: erasedText(body.seed_spec.how_we_know), out_of_scope: erasedText(body.seed_spec.out_of_scope) };
  return tombstone;
}

export class Store {
  migrateStagePosts() {
    this.db.exec(`CREATE TABLE stage_posts(item TEXT NOT NULL, post_id TEXT NOT NULL, kind TEXT NOT NULL,
      opened_seq INTEGER NOT NULL, previous_post_id TEXT, closed_seq INTEGER, snapshot_hash TEXT,
      successor_post_id TEXT, PRIMARY KEY(item,post_id));
      CREATE UNIQUE INDEX stage_one_active ON stage_posts(item) WHERE closed_seq IS NULL;
      CREATE TABLE closeout_jobs(item TEXT NOT NULL, post_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(item,post_id,snapshot_hash));
      ALTER TABLE effort_jobs ADD COLUMN post_id TEXT;
      ALTER TABLE effort_jobs ADD COLUMN post_version TEXT;`);
  }
  stageProjection(item) {
    let context = initial();
    const posts = [], jobs = [], byId = new Map();
    let previous = '';
    for (const row of this.eventRows(item)) {
      const event = this.eventFromRow(row), before = context.activePost;
      const next = step(context, event, this.authorityFromRow(row));
      if (next.refusal) throw new Error(`stage replay refused: ${next.refusal}`);
      context = next.context;
      const after = context.activePost;
      if (context.rules === 3) {
        if (!before && after && ['posted', 'forked'].includes(event.type)) {
          const post = { item, post_id: after.id, kind: after.kind, opened_seq: row.seq, previous_post_id: null, closed_seq: null, snapshot_hash: null, successor_post_id: null };
          posts.push(post); byId.set(post.post_id, post);
        } else if (before && before.id !== after?.id) {
          const post = byId.get(before.id);
          if (!post || post.closed_seq !== null) throw new Error('stage projection inconsistent');
          const closingEventIncluded = ['helped', 'shelved', 'failed'].includes(event.type);
          const snapshotSeq = closingEventIncluded ? row.seq : row.seq - 1;
          const snapshotHash = closingEventIncluded ? row.hash : previous;
          const decisionId = ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type) ? `decision:${row.body_hash}` : null;
          Object.assign(post, { closed_seq: snapshotSeq, snapshot_hash: snapshotHash, successor_post_id: decisionId ?? after?.id ?? null });
          jobs.push({ item, post_id: post.post_id, snapshot_hash: snapshotHash });
          if (after) {
            const successor = { item, post_id: after.id, kind: after.kind, opened_seq: row.seq, previous_post_id: decisionId ?? before.id, closed_seq: null, snapshot_hash: null, successor_post_id: null };
            posts.push(successor); byId.set(successor.post_id, successor);
          }
          if (['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)) {
            const decision = { item, post_id: decisionId, kind: 'decision', opened_seq: row.seq, previous_post_id: before.id, closed_seq: row.seq, snapshot_hash: row.hash, successor_post_id: after?.id ?? null };
            posts.push(decision); jobs.push({ item, post_id: decision.post_id, snapshot_hash: row.hash });
          }
        }
      }
      previous = row.hash;
    }
    return { posts: posts.sort((a,b) => a.post_id.localeCompare(b.post_id)), jobs: jobs.sort((a,b) => a.post_id.localeCompare(b.post_id)) };
  }
  rebuildStagePosts() {
    this.db.exec('DELETE FROM stage_posts');
    for (const { item } of this.db.prepare('SELECT DISTINCT item FROM events').all()) {
      const projection = this.stageProjection(item);
      for (const p of projection.posts) this.db.prepare('INSERT INTO stage_posts VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(p));
      for (const j of projection.jobs) this.db.prepare('INSERT OR IGNORE INTO closeout_jobs(item,post_id,snapshot_hash) VALUES(?,?,?)').run(...Object.values(j));
    }
    this.db.exec('DELETE FROM closeout_jobs WHERE NOT EXISTS (SELECT 1 FROM stage_posts p WHERE p.item=closeout_jobs.item AND p.post_id=closeout_jobs.post_id AND p.snapshot_hash=closeout_jobs.snapshot_hash)');
  }
  migrateF6() { initializeMentoring(this); }
  migrateF5() { initializeMemory(this); }
  search(person, text, options) { return searchMemory(this, person, text, options); }
  contributions(viewer, subject) { return contributionMemory(this, viewer, subject); }
  migrateF4() {
    this.db.exec(`CREATE TABLE lineage(child TEXT PRIMARY KEY, parent_item TEXT NOT NULL,
      parent_seq INTEGER NOT NULL, parent_hash TEXT NOT NULL, source_kind TEXT, source_body_hash TEXT);
      CREATE INDEX lineage_parent ON lineage(parent_item);`);
    this.rebuildLineage();
  }

  forkPoint(item, selection, sequence, { extended = false } = {}) {
    const events = this.events(item), rows = this.eventRows(item);
    const snapshot = selection?.kind === 'snapshot' ? this.db.prepare('SELECT closed_seq FROM stage_posts WHERE item=? AND snapshot_hash=? AND post_id=?').get(item, selection.hash, selection.post_id) : null;
    const index = selection?.kind === 'snapshot' ? (snapshot?.closed_seq ?? 0) - 1 : selection ? events.findIndex(event => event.body_hash === selection.hash) : (sequence ?? events.length) - 1;
    const selected = events[index], row = rows[index];
    const kinds = { see: ['posted', 'forked', 'revised', 'checked', 'seen'], spec: ['specced'], artifact: ['tried'] };
    if (!row || (selection && selection.kind !== 'snapshot' && !kinds[selection.kind]?.includes(selected.type))) throw refused('fork selection does not match its parent event');
    const history = events.slice(0, index + 1);
    const first = history[0];
    const original = history.filter(event => event.type === 'revised').at(-1)?.text ?? first?.original ?? first?.problem;
    const spec = history.filter(event => event.type === 'specced').at(-1);
    const seed_spec = spec ? { must: spec.must, how_we_know: spec.how_we_know, out_of_scope: spec.out_of_scope,
      ...(spec.scope ? { scope: spec.scope } : {}),
      ...(extended ? Object.fromEntries(['assumptions', 'open_questions'].filter(key => spec[key] !== undefined).map(key => [key, spec[key]])) : {}) } : undefined;
    return { original, ...(seed_spec ? { seed_spec } : {}), parent: { item, seq: row.seq, hash: row.hash } };
  }

  lineageOf(item) {
    const first = this.events(item)[0];
    if (first?.type !== 'forked') return null;
    return { child: item, parent_item: first.parent.item, parent_seq: first.parent.seq, parent_hash: first.parent.hash,
      source_kind: first.from?.kind || null, source_body_hash: first.from?.hash || null };
  }

  recordLineage(item) {
    const row = this.lineageOf(item);
    if (row) this.db.prepare('INSERT INTO lineage VALUES(?,?,?,?,?,?)').run(...Object.values(row));
  }

  rebuildLineage() {
    this.db.exec('DELETE FROM lineage');
    for (const { item } of this.db.prepare("SELECT item FROM events WHERE seq=1 AND type='forked'").all()) this.recordLineage(item);
  }
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

  migrateR() {
    const columns = this.db.prepare('PRAGMA table_info(runs)').all().map(row => row.name);
    if (!columns.includes('see_hash')) this.db.exec('ALTER TABLE runs ADD COLUMN see_hash TEXT');
    // The machine now tracks supersession, so the derived item cache is rebuilt from the events.
    this.rebuild();
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

  ensureEvent(item, event, { importing = false } = {}) {
    if (!item || !event?.type || !event.actor) throw refused('item, event, and actor required');
    if (Object.hasOwn(event, 'role')) throw refused('event role is forbidden');
    if (typeof event.at !== 'string' || !event.at) throw refused('event.at required');
    this.actor(event.actor, item);
    if (!importing && this.read(item).context.rules >= 3 && ['returned', 'not_built'].includes(event.type))
      throw refused('legacy decision type unavailable for current rules');
    if (event.type === 'credit_note') {
      const source = this.db.prepare(`SELECT e.actor,b.erased FROM events e JOIN bodies b ON b.hash=e.body_hash
        WHERE e.item=? AND e.body_hash=?`).get(item, event.source);
      const target = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(event.person);
      const erasedReceipt = this.db.prepare(`SELECT 1 FROM events e JOIN bodies b ON b.hash=e.body_hash
        WHERE e.item=? AND e.type='erased' AND json_extract(b.bytes,'$.body_hash')=?`).get(item, event.source);
      if (!source || ((source.erased || erasedReceipt) && !importing) || source.actor !== event.person || !['person', 'agent'].includes(target?.kind))
        throw refused('credit source must be an unerased contribution by this person in this item');
    }
    if (event.type === 'steward_changed') {
      const next = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(event.steward);
      if (!next || next.kind !== 'person') throw invalid('steward must be a registered person');
      const context = this.read(item).context;
      if (context.rules >= 2) {
        const consented = this.events(item).some(entry => entry.type === 'checked_in'
          && entry.actor === context.steward && entry.consent === true);
        const last = this.db.prepare('SELECT at FROM events WHERE actor=? ORDER BY at DESC LIMIT 1').get(context.steward);
        // Both values are event data, not a wall-clock read. The event being
        // appended supplies the comparison point, which keeps replay deterministic.
        const currentAt = new Date(event.at).getTime();
        const lastAt = last && new Date(last.at).getTime();
        const inactiveForFourteenDays = Number.isSafeInteger(currentAt) && Number.isSafeInteger(lastAt)
          && currentAt - lastAt >= 14 * 24 * 60 * 60 * 1000;
        if (!consented && !inactiveForFourteenDays) throw refused('steward consent or fourteen days of inactivity required');
      }
    }
    if (event.type === 'erased') {
      // Every path to an erasure (the product, a direct append, an import) meets the same rules.
      const context = this.read(item).context;
      const authority = this.actor(event.actor, item);
      const privileged = authority?.leader === true || event.actor === context.steward;
      if (!(context.rules >= 2)) {
        if (!privileged) throw refused('event not allowed');
      } else {
        const target = this.db.prepare('SELECT type, actor FROM events WHERE item=? AND body_hash=?').get(item, event.body_hash);
        if (!target) { if (!privileged) throw refused('event not allowed'); }
        else {
          if (['posted', 'forked', 'approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew', 'sent'].includes(target.type)) throw refused('decision records and original SEEs cannot erase');
          if (target.actor !== event.actor) {
            if (!privileged) throw refused('event not allowed');
            if (!['privacy', 'legal', 'safety', 'customer or employee personal data'].includes(event.ground)) throw refused('erase ground required');
            if (typeof event.note !== 'string' || event.note.length < 1 || event.note.length > 2000) throw refused('erase note required');
          }
        }
      }
    }
    if (event.type === 'posted' && this.eventRows(item).length !== 0) throw refused('posted event requires a fresh item');
    if (event.type === 'forked') {
      if (this.eventRows(item).length !== 0) throw refused('forked event requires a fresh item');
      const parent = event.parent;
      const row = parent && typeof parent.item === 'string' && Number.isInteger(parent.seq)
        ? this.db.prepare('SELECT hash FROM events WHERE item=? AND seq=?').get(parent.item, parent.seq)
        : null;
      if (!row || row.hash !== parent.hash) throw refused('fork parent does not match');
      if (event.from !== undefined) {
        const selected = this.events(parent.item)[parent.seq - 1];
        const kinds = { see: ['posted', 'forked', 'revised', 'checked', 'seen'], spec: ['specced'], artifact: ['tried'] };
        if (!selected || (event.from?.kind === 'snapshot' ? !this.db.prepare('SELECT 1 FROM stage_posts WHERE item=? AND closed_seq=? AND snapshot_hash=? AND post_id=?').get(parent.item, parent.seq, event.from.hash, event.from.post_id) : (!kinds[event.from?.kind]?.includes(selected.type) || selected.body_hash !== event.from.hash)))
          throw refused('fork selection does not match its parent event');
      }
      if (event.from !== undefined || event.seed_spec !== undefined || event.seed_policy === 2) {
        const point = this.forkPoint(parent.item, event.from, parent.seq, { extended: event.seed_policy === 2 });
        // Imported fork copies are historical records in their own chains. A
        // later parent erasure cannot recover or re-hash the original source.
        const redactedParent = importing && this.eventRows(parent.item).slice(0, parent.seq)
          .some(entry => this.db.prepare('SELECT erased FROM bodies WHERE hash=?').get(entry.body_hash)?.erased === 1);
        if (!redactedParent && (event.original !== point.original || stable(event.seed_spec) !== stable(point.seed_spec)))
          throw refused('fork content must match the selected historical point');
      }
    }
    if (event.type === 'specced' && event.scope !== undefined && !validScope(event.scope)) throw refused('invalid approved scope');
    if (event.type === 'steered' && event.scope !== undefined) {
      const specHash = this.read(item).context.specHash;
      const approved = this.events(item).find(entry => entry.type === 'specced' && entry.body_hash === specHash);
      if (!withinScope(approved?.scope || emptyScope(), event.scope)) throw refused('scope expansion requires a new spec and approval');
    }
    if (event.type === 'commented' && event.parent !== undefined) {
      const parent = this.db.prepare(`SELECT b.bytes FROM events e JOIN bodies b ON b.hash=e.body_hash
        WHERE e.item=? AND e.body_hash=? AND e.type='commented'`).get(item, event.parent);
      if (!parent) throw refused('parent must be a comment in this item');
      let body;
      try { body = JSON.parse(parent.bytes); } catch { throw refused('parent is invalid'); }
      if (body.anchor_kind !== event.anchor_kind || body.anchor_hash !== event.anchor_hash) throw refused('parent anchor does not match');
      if (this.read(item).context.rules === 3 && body.post_id !== event.post_id) throw refused('parent belongs to a frozen post');
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
    if (this.read(item).context.rules === 3 && event.type === 'specced' && Array.isArray(event.credits)) for (const credit of event.credits) {
      const row = comment(credit.comment);
      if (!row || (row.erased && !importing)) throw refused('credit must reference an unerased comment in this item');
      const body = JSON.parse(row.bytes);
      if (!row.erased && credit.mode === 'quoted' && ![...(event.must || []), ...(event.how_we_know || []), ...(event.out_of_scope || []),
        ...(event.assumptions || []), ...(event.open_questions || [])].some(text => text.includes(body.comment)))
        throw refused('quoted credit must be verbatim in the comment and spec');
    }
    if (event.type === 'steered' && event.source) {
      const row = comment(event.source);
      if (!row || row.erased) throw refused('steer source must be an unerased comment in this item');
      if (this.read(item).context.rules === 3 && JSON.parse(row.bytes).post_id !== event.post_id) throw refused('steer source belongs to a frozen post');
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
    this.ensureEvent(item, event, options);
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
    if (outcome.context.rules === 3) {
      const before = prior.context.activePost, after = outcome.context.activePost;
      if (!before && after && ['posted', 'forked'].includes(event.type)) {
        this.db.prepare('INSERT INTO stage_posts(item,post_id,kind,opened_seq) VALUES(?,?,?,?)').run(item, after.id, after.kind, seq);
      } else if (before && before.id !== after?.id) {
        const closingEventIncluded = ['helped', 'shelved', 'failed'].includes(event.type);
        const snapshotSeq = closingEventIncluded ? seq : currentSeq;
        const snapshotHash = closingEventIncluded ? hash : previous;
        const decisionId = ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type) ? `decision:${hashOfBody}` : null;
        const changed = this.db.prepare('UPDATE stage_posts SET closed_seq=?,snapshot_hash=?,successor_post_id=? WHERE item=? AND post_id=? AND closed_seq IS NULL')
          .run(snapshotSeq, snapshotHash, decisionId ?? after?.id ?? null, item, before.id);
        if (changed.changes !== 1) throw refused('post freeze inconsistent');
        this.db.prepare('INSERT INTO closeout_jobs(item,post_id,snapshot_hash) VALUES(?,?,?)').run(item, before.id, snapshotHash);
        if (after) this.db.prepare('INSERT INTO stage_posts(item,post_id,kind,opened_seq,previous_post_id) VALUES(?,?,?,?,?)')
          .run(item, after.id, after.kind, seq, decisionId ?? before.id);
        if (['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)) {
          const decision = decisionId;
          this.db.prepare('INSERT INTO stage_posts(item,post_id,kind,opened_seq,previous_post_id,closed_seq,snapshot_hash,successor_post_id) VALUES(?,?,?,?,?,?,?,?)')
            .run(item, decision, 'decision', seq, before.id, seq, hash, after?.id ?? null);
          this.db.prepare('INSERT INTO closeout_jobs(item,post_id,snapshot_hash) VALUES(?,?,?)').run(item, decision, hash);
        }
      }
    }
    this.enqueueIntegrationOutbox(item, event, outcome.state, seq);
    if (event.type === 'forked') this.recordLineage(item);
    if (event.type === 'posted' || event.type === 'forked' || (event.type === 'specced' && prior.context.specHash === null) || (outcome.context.rules === 3 && ['returned', 'failed'].includes(event.type))) {
      const kind = ['specced', 'returned', 'failed'].includes(event.type) ? 'spec_draft' : 'see_first';
      const now = new Date(event.at).getTime();
      this.db.prepare(`INSERT OR IGNORE INTO effort_jobs(id,item,kind,trigger_seq,requester,state,attempts,next_at,last_error,created)
        VALUES(?,?,?,?,?,'queued',0,?,NULL,?)`)
        .run(digest(stable(['effort', item, kind, seq])), item, kind, seq, ['returned', 'failed'].includes(event.type) ? outcome.context.steward : event.actor, now, now);
    }
    if (outcome.context.rules === 3) this.db.prepare('UPDATE effort_jobs SET post_id=?,post_version=? WHERE item=? AND trigger_seq=? AND post_id IS NULL').run(outcome.context.activePost?.id ?? null, outcome.context.activePost?.version ?? null, item, seq);
    // A mention is a request, never an instruction. Agent output cannot ask itself
    // for more work, and hitting a cap never prevents the person's comment landing.
    if (event.type === 'commented' && authority.kind === 'person' && /@effort\b/i.test(event.comment)) {
      const dayStart = new Date(event.at); dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
      const tagsByPerson = this.db.prepare("SELECT count(*) AS n FROM effort_jobs WHERE kind='tag' AND requester=? AND created>=? AND created<?")
        .get(event.actor, dayStart.getTime(), dayEnd).n;
      const tagsByItem = this.db.prepare("SELECT count(*) AS n FROM effort_jobs WHERE kind='tag' AND item=? AND created>=? AND created<?")
        .get(item, dayStart.getTime(), dayEnd).n;
      if (tagsByPerson < 10 && tagsByItem < 30) this.db.prepare(`INSERT OR IGNORE INTO effort_jobs(id,item,kind,trigger_seq,requester,state,attempts,next_at,last_error,created)
        VALUES(?,?,?,?,?,'queued',0,?,NULL,?)`).run(digest(stable(['effort', item, 'tag', seq])), item, 'tag', seq, event.actor, new Date(event.at).getTime(), new Date(event.at).getTime());
    }
    if (outcome.effects.some(effect => effect.kind === 'build.stop')) {
      this.db.prepare("UPDATE runs SET status='stop_requested' WHERE item=? AND approval=? AND status='active'")
        .run(item, prior.context.approval);
    }
    if (outcome.context.rules === 3) this.db.prepare('UPDATE effort_jobs SET post_id=?,post_version=? WHERE item=? AND trigger_seq=? AND post_id IS NULL').run(outcome.context.activePost?.id ?? null, outcome.context.activePost?.version ?? null, item, seq);
    syncMemory(this, item);
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
      ...this.db.prepare('SELECT child FROM lineage').all().map(row => row.child),
      ...this.db.prepare('SELECT DISTINCT item FROM search_docs').all().map(row => row.item),
      ...this.db.prepare('SELECT DISTINCT item FROM contributions').all().map(row => row.item),
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
      if (!same) return { item, ok: false, reason: 'cache' };
      const lineage = this.db.prepare('SELECT * FROM lineage WHERE child=?').get(item);
      const expectedLineage = this.lineageOf(item);
      if (stable(lineage || null) !== stable(expectedLineage)) return { item, ok: false, reason: 'lineage' };
      if (expectedLineage) {
        const parent = this.db.prepare('SELECT hash FROM events WHERE item=? AND seq=?').get(expectedLineage.parent_item, expectedLineage.parent_seq);
        if (parent?.hash !== expectedLineage.parent_hash) return { item, ok: false, reason: 'lineage-parent' };
      }
      if (!verifyMemory(this, item)) return { item, ok: false, reason: 'memory' };
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='stage_posts'").get()) {
        const expected = this.stageProjection(item);
        const posts = this.db.prepare('SELECT * FROM stage_posts WHERE item=? ORDER BY post_id').all(item);
        const jobs = this.db.prepare('SELECT item,post_id,snapshot_hash FROM closeout_jobs WHERE item=? ORDER BY post_id').all(item);
        if (stable(posts) !== stable(expected.posts) || stable(jobs) !== stable(expected.jobs)) return { item, ok: false, reason: 'stage-projection' };
      }
      return { item, ok: true };
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
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lineage'").get()) this.rebuildLineage();
    rebuildMemory(this);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='stage_posts'").get()) this.rebuildStagePosts();
  }

  erase(item, targetHash, actor, at, { ground, note } = {}) {
    if (!targetHash || !actor || typeof at !== 'string' || !at) throw new Error('erase arguments required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const target = this.db.prepare('SELECT * FROM events WHERE item=? AND body_hash=?').get(item, targetHash);
      if (!target) throw new Error('body is not part of item');
      const rules2 = this.read(item).context.rules >= 2;
      if (rules2 && ['posted', 'forked', 'approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew', 'sent'].includes(target.type)) throw refused('decision records and original SEEs cannot erase');
      const authority = this.actor(actor, item);
      if (!rules2 && !(authority?.leader || actor === this.read(item).context.steward)) throw refused('event not allowed');
      if (rules2 && target.actor !== actor) {
        if (!(authority?.leader || actor === this.read(item).context.steward)) throw refused('event not allowed');
        if (!['privacy', 'legal', 'safety', 'customer or employee personal data'].includes(ground)) throw refused('erase ground required');
        if (typeof note !== 'string' || note.length < 1 || note.length > 2000) throw refused('erase note required');
      }
      const current = this.db.prepare('SELECT seq FROM items WHERE item=?').get(item);
      const body = this.db.prepare('SELECT bytes FROM bodies WHERE hash=?').get(targetHash);
      if (!body) throw new Error('body is already erased');
      const tombstone = stable(redactBody(target.type, JSON.parse(body.bytes)));
      const redacted_hash = scopedBodyHash(item, tombstone);
      this.appendInTransaction(item, { type: 'erased', actor, body_hash: targetHash,
        redacted_hash, ...(target.actor !== actor ? { ground, note } : {}), at }, {
        expectedSeq: current?.seq || 0, idem: `erase:${targetHash}`,
      });
      // Keep machine fields so an erasure cannot corrupt item history.
      this.db.prepare('UPDATE bodies SET bytes=?, erased=1 WHERE hash=?').run(tombstone, targetHash);
      syncMemory(this, item);
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
    const artifacts = new Map();
    for (const row of rows) {
      if (!['sent', 'tried'].includes(row.type)) continue;
      const body = JSON.parse(row.bytes);
      const hash = row.type === 'sent' ? body.packet_hash : body.artifact_hash;
      const bytes = this.artifact(row.item, hash);
      if (bytes !== null) artifacts.set(`${row.item}:${hash}`, { item: row.item, hash, bytes });
    }
    lines.push(...[...artifacts.values()].sort((a, b) => `${a.item}:${a.hash}`.localeCompare(`${b.item}:${b.hash}`)).map(artifact => JSON.stringify({ artifact })));
    lines.push(...rows.map(row => JSON.stringify(row)));
    lines.push(JSON.stringify({ complete: true, events: rows.length, actors: actors.length, artifacts: artifacts.size }));
    return `${lines.join('\n')}\n`;
  }

  importJsonl(text) {
    const lines = text.trim() ? text.trim().split('\n').map(JSON.parse) : [];
    const footer = lines.pop();
    const actors = lines.filter(row => row.registry).map(row => row.registry);
    const artifacts = lines.filter(row => row.artifact).map(row => row.artifact);
    const events = lines.filter(row => !row.registry && !row.artifact);
    if (!footer?.complete || footer.events !== events.length || footer.actors !== actors.length) {
      throw new Error('incomplete import');
    }
    if ((footer.artifacts ?? 0) !== artifacts.length) throw new Error('incomplete artifact import');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const actor of actors) this.importActor(actor);
      for (const artifact of artifacts) {
        if (typeof artifact.item !== 'string' || typeof artifact.hash !== 'string'
          || this.putArtifact(artifact.item, artifact.bytes) !== artifact.hash) throw new Error('bad import artifact');
      }
      const groups = new Map();
      for (const row of events) {
        if (!groups.has(row.item)) groups.set(row.item, []);
        groups.get(row.item).push(row);
      }
      const visiting = new Set(), imported = new Set();
      const importItem = item => {
        if (imported.has(item)) return;
        if (visiting.has(item)) throw new Error('cyclic fork lineage');
        const rows = groups.get(item);
        if (!rows) return; // ensureEvent still checks parents already in this store.
        visiting.add(item);
        const first = rows.find(row => row.seq === 1);
        if (first?.type === 'forked') importItem(JSON.parse(first.bytes).parent.item);
        for (const row of rows.sort((a, b) => a.seq - b.seq)) this.importRow(row, events);
        visiting.delete(item); imported.add(item);
      };
      for (const item of groups.keys()) importItem(item);
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
      importing: true,
    });
    if (answer.hash !== row.hash) throw new Error('import hash differs');
    if (erased) this.db.prepare('UPDATE bodies SET erased=1 WHERE hash=?').run(row.body_hash);
  }

  close() { this.db.close(); }
}
