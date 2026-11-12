// Every table, index and seed row the product owns. Only the migration runner in
// core/migrations.js executes these, once per database version. Routine opens never do.
// Nothing here imports other modules, so the migration list has no import cycles.

export const BASELINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS actors(
    id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run','source')),
    leader INTEGER DEFAULT 0, item TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS events(
    item TEXT, seq INTEGER, type TEXT, actor TEXT, body_hash TEXT,
    prev_hash TEXT, hash TEXT, at TEXT, idem TEXT, submitted_hash TEXT,
    actor_kind TEXT, actor_leader INTEGER, authority_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(item,seq), UNIQUE(item,idem)
  );
  CREATE TABLE IF NOT EXISTS bodies(
    hash TEXT PRIMARY KEY, bytes TEXT, erased INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS items(
    item TEXT PRIMARY KEY, state TEXT, head TEXT, seq INTEGER, context TEXT
  );
  CREATE TABLE IF NOT EXISTS integration_sources(
    name TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, rate_limit INTEGER NOT NULL DEFAULT 30
  );
  CREATE TABLE IF NOT EXISTS integration_replays(
    source TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(source,digest)
  );
  CREATE TABLE IF NOT EXISTS integration_destinations(
    name TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, include_text INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, allow_loopback INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS integration_outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT, destination TEXT NOT NULL, item TEXT NOT NULL, seq INTEGER NOT NULL,
    event_type TEXT NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
    next_at INTEGER NOT NULL, created INTEGER NOT NULL, delivered INTEGER, last_error TEXT,
    UNIQUE(destination,item,seq)
  );
  CREATE TABLE IF NOT EXISTS worker_control(id INTEGER PRIMARY KEY CHECK(id=1), killed INTEGER NOT NULL);
  INSERT OR IGNORE INTO worker_control VALUES(1,0);
  CREATE TABLE IF NOT EXISTS worker_history(seq INTEGER PRIMARY KEY, action TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(
    id TEXT PRIMARY KEY, item TEXT NOT NULL, approval INTEGER NOT NULL, spec_hash TEXT NOT NULL,
    run_actor TEXT UNIQUE NOT NULL, gateway_actor TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(item,approval)
  );
  CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS fake_jobs(id TEXT PRIMARY KEY, input TEXT NOT NULL, html TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY, password TEXT NOT NULL, leader INTEGER NOT NULL DEFAULT 0,
    lock_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS login_failures(
    account TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS login_failures_account ON login_failures(account, at);
  CREATE TABLE IF NOT EXISTS invites(
    digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions(
    digest TEXT PRIMARY KEY, person TEXT NOT NULL, csrf TEXT NOT NULL, created INTEGER NOT NULL,
    seen INTEGER NOT NULL, expires INTEGER NOT NULL, stepup INTEGER NOT NULL DEFAULT 0,
    stepup_used INTEGER NOT NULL DEFAULT 0, auth_method TEXT NOT NULL DEFAULT 'password',
    review_item TEXT, review_spec_hash TEXT, review_seq INTEGER
  );
  CREATE TABLE IF NOT EXISTS api_tokens(
    digest TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS person_state(
    id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS gateway_policy(id INTEGER PRIMARY KEY CHECK(id=1), bytes TEXT, seal TEXT);
  CREATE TABLE IF NOT EXISTS gateway_policy_versions(version INTEGER PRIMARY KEY, bytes TEXT NOT NULL, seal TEXT NOT NULL);
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
  CREATE TABLE IF NOT EXISTS gateway_hold_audit(id TEXT PRIMARY KEY, receipt TEXT NOT NULL, actor TEXT NOT NULL,
    at INTEGER NOT NULL, action TEXT NOT NULL, refund INTEGER NOT NULL, reason TEXT NOT NULL, seal TEXT NOT NULL);
  INSERT OR IGNORE INTO gateway_integrity SELECT 1,0 WHERE NOT EXISTS(SELECT 1 FROM gateway_receipts);
  CREATE TABLE IF NOT EXISTS gateway_quest_receipts(
    id TEXT PRIMARY KEY, person TEXT NOT NULL, idem TEXT NOT NULL, payload_hash TEXT NOT NULL,
    policy TEXT NOT NULL, day TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
    worst_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, state TEXT NOT NULL,
    usage TEXT, outcome TEXT, seal TEXT NOT NULL, UNIQUE(person,idem));
  CREATE TABLE IF NOT EXISTS container_jobs(
    id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, container_name TEXT NOT NULL,
    token_digest TEXT, deadline INTEGER NOT NULL, output_path TEXT NOT NULL, error TEXT
  );`;

// Columns that older releases added with ALTER TABLE. The runner adds each one only when
// PRAGMA table_info shows it missing. Any other failure stops the open.
export const LEGACY_COLUMNS = [
  ['items', 'context', 'TEXT'],
  ['events', 'submitted_hash', 'TEXT'],
  ['events', 'actor_kind', 'TEXT'],
  ['events', 'actor_leader', 'INTEGER'],
  ['events', 'authority_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['bodies', 'erased', 'INTEGER NOT NULL DEFAULT 0'],
  ['runs', 'started_at', 'INTEGER'],
  ['sessions', 'auth_method', "TEXT NOT NULL DEFAULT 'password'"],
  ['sessions', 'review_item', 'TEXT'],
  ['sessions', 'review_spec_hash', 'TEXT'],
  ['sessions', 'review_seq', 'INTEGER'],
  ['users', 'must_change', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'temp_used', 'INTEGER NOT NULL DEFAULT 0'],
  ['invites', 'revoked', 'INTEGER NOT NULL DEFAULT 0'],
];
