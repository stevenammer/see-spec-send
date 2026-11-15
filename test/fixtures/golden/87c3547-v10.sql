-- Golden SQLite dump, PRAGMA user_version=10.
PRAGMA user_version=10;
CREATE TABLE actors(id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run','source','agent')),
          leader INTEGER DEFAULT 0, item TEXT NULL);
CREATE TABLE api_tokens(
    digest TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL
  );
CREATE TABLE bodies(
    hash TEXT PRIMARY KEY, bytes TEXT, erased INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE container_jobs(
    id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, container_name TEXT NOT NULL,
    token_digest TEXT, deadline INTEGER NOT NULL, output_path TEXT NOT NULL, error TEXT
  );
CREATE TABLE contributions(item TEXT NOT NULL, seq INTEGER NOT NULL, person TEXT NOT NULL, action TEXT NOT NULL,
        ref_hash TEXT NOT NULL, source_item TEXT NOT NULL, ai INTEGER NOT NULL, erased INTEGER NOT NULL,
        PRIMARY KEY(item,seq,person,action,ref_hash));
CREATE TABLE effort_jobs(
      id TEXT PRIMARY KEY, item TEXT NOT NULL, kind TEXT NOT NULL, trigger_seq INTEGER NOT NULL,
      requester TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER, last_error TEXT, created INTEGER NOT NULL, UNIQUE(item,kind,trigger_seq)
    );
CREATE TABLE events(
    item TEXT, seq INTEGER, type TEXT, actor TEXT, body_hash TEXT,
    prev_hash TEXT, hash TEXT, at TEXT, idem TEXT, submitted_hash TEXT,
    actor_kind TEXT, actor_leader INTEGER, authority_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(item,seq), UNIQUE(item,idem)
  );
CREATE TABLE fake_jobs(id TEXT PRIMARY KEY, input TEXT NOT NULL, html TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE gateway_capabilities(
    digest TEXT PRIMARY KEY, run TEXT NOT NULL, item TEXT NOT NULL, approval INTEGER NOT NULL,
    spec_hash TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE gateway_effort_receipts(
      id TEXT PRIMARY KEY, person TEXT NOT NULL, idem TEXT NOT NULL, payload_hash TEXT NOT NULL,
      policy TEXT NOT NULL, day TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
      worst_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, state TEXT NOT NULL,
      usage TEXT, outcome TEXT, seal TEXT NOT NULL, item TEXT NOT NULL, job TEXT NOT NULL,
      UNIQUE(person,idem)
    );
CREATE TABLE gateway_hold_audit(id TEXT PRIMARY KEY, receipt TEXT NOT NULL, actor TEXT NOT NULL,
    at INTEGER NOT NULL, action TEXT NOT NULL, refund INTEGER NOT NULL, reason TEXT NOT NULL, seal TEXT NOT NULL);
CREATE TABLE gateway_integrity(id INTEGER PRIMARY KEY CHECK(id=1), receipt_count INTEGER NOT NULL);
CREATE TABLE gateway_policy(id INTEGER PRIMARY KEY CHECK(id=1), bytes TEXT, seal TEXT);
CREATE TABLE gateway_policy_versions(version INTEGER PRIMARY KEY, bytes TEXT NOT NULL, seal TEXT NOT NULL);
CREATE TABLE gateway_quest_receipts(
    id TEXT PRIMARY KEY, person TEXT NOT NULL, idem TEXT NOT NULL, payload_hash TEXT NOT NULL,
    policy TEXT NOT NULL, day TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
    worst_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, state TEXT NOT NULL,
    usage TEXT, outcome TEXT, seal TEXT NOT NULL, UNIQUE(person,idem));
CREATE TABLE gateway_receipts(
    id TEXT PRIMARY KEY, run TEXT NOT NULL, idem TEXT NOT NULL, item TEXT NOT NULL, approval INTEGER NOT NULL,
    spec_hash TEXT NOT NULL, approval_hash TEXT NOT NULL, cap_micros INTEGER NOT NULL,
    payload_hash TEXT NOT NULL, rate TEXT NOT NULL, policy TEXT NOT NULL, day TEXT NOT NULL,
    input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL, worst_micros INTEGER NOT NULL,
    charged_micros INTEGER NOT NULL, state TEXT NOT NULL, usage TEXT, outcome TEXT, seal TEXT NOT NULL,
    UNIQUE(run,idem));
CREATE TABLE integration_destinations(
    name TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, include_text INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, allow_loopback INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE integration_outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT, destination TEXT NOT NULL, item TEXT NOT NULL, seq INTEGER NOT NULL,
    event_type TEXT NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
    next_at INTEGER NOT NULL, created INTEGER NOT NULL, delivered INTEGER, last_error TEXT,
    UNIQUE(destination,item,seq)
  );
CREATE TABLE integration_replays(
    source TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(source,digest)
  );
CREATE TABLE integration_sources(
    name TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, rate_limit INTEGER NOT NULL DEFAULT 30
  );
CREATE TABLE invites(
    digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
  , revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE items(
    item TEXT PRIMARY KEY, state TEXT, head TEXT, seq INTEGER, context TEXT
  );
CREATE TABLE lineage(child TEXT PRIMARY KEY, parent_item TEXT NOT NULL,
      parent_seq INTEGER NOT NULL, parent_hash TEXT NOT NULL, source_kind TEXT, source_body_hash TEXT);
CREATE TABLE login_failures(
    account TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL
  );
CREATE TABLE person_state(
    id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE research_config(source TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE runs(
          id TEXT PRIMARY KEY, item TEXT NOT NULL, approval INTEGER NOT NULL, iteration INTEGER NOT NULL DEFAULT 0,
          spec_hash TEXT NOT NULL, run_actor TEXT UNIQUE NOT NULL, gateway_actor TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, started_at INTEGER, see_hash TEXT,
          UNIQUE(item,approval,iteration)
        );
CREATE VIRTUAL TABLE search_docs USING fts5(item UNINDEXED,seq UNINDEXED,kind UNINDEXED,author UNINDEXED,hash UNINDEXED,text);
CREATE TABLE sessions(
    digest TEXT PRIMARY KEY, person TEXT NOT NULL, csrf TEXT NOT NULL, created INTEGER NOT NULL,
    seen INTEGER NOT NULL, expires INTEGER NOT NULL, stepup INTEGER NOT NULL DEFAULT 0,
    stepup_used INTEGER NOT NULL DEFAULT 0, auth_method TEXT NOT NULL DEFAULT 'password',
    review_item TEXT, review_spec_hash TEXT, review_seq INTEGER
  );
CREATE TABLE users(
    id TEXT PRIMARY KEY, password TEXT NOT NULL, leader INTEGER NOT NULL DEFAULT 0,
    lock_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
  , must_change INTEGER NOT NULL DEFAULT 0, temp_used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE worker_control(id INTEGER PRIMARY KEY CHECK(id=1), killed INTEGER NOT NULL);
CREATE TABLE worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
CREATE TABLE worker_history(seq INTEGER PRIMARY KEY, action TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX contributions_person ON contributions(person,item,seq);
CREATE INDEX lineage_parent ON lineage(parent_item);
CREATE INDEX login_failures_account ON login_failures(account, at);
INSERT INTO "actors"("id","kind","leader","item") VALUES('effort','agent',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('owner','person',0,NULL);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('ab8d81c97681e2b0f3e625b84408e51956365aebf8f2ebd47f54bb5a0e96e075','{"original":"A note survives a transfer.","rules":2}',0);
INSERT INTO "contributions"("item","seq","person","action","ref_hash","source_item","ai","erased") VALUES('memory',1,'owner','authored','ab8d81c97681e2b0f3e625b84408e51956365aebf8f2ebd47f54bb5a0e96e075','memory',0,0);
INSERT INTO "effort_jobs"("id","item","kind","trigger_seq","requester","state","attempts","next_at","last_error","created") VALUES('0d5ca1944d3e706c13bf5b24e6dd993a9b3f0de8cef31dba2d42a6b6c4d207d0','memory','see_first',1,'owner','queued',0,1794733200000,NULL,1794733200000);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('memory',1,'posted','owner','ab8d81c97681e2b0f3e625b84408e51956365aebf8f2ebd47f54bb5a0e96e075','','92eef6aeb080a876b934da16a74776986a08d46e07389d9706bfc0de7f921da7','2026-11-15T09:00:00.000Z','original','38b97a9d3bf96fc2df3739a9732d08df8ea67a8335c9ca254e4ace6004a7e51e','person',0,1);
INSERT INTO "gateway_integrity"("id","receipt_count") VALUES(1,0);
INSERT INTO "items"("item","state","head","seq","context") VALUES('memory','SEEN','92eef6aeb080a876b934da16a74776986a08d46e07389d9706bfc0de7f921da7',1,'{"approval":0,"approver":null,"artifact":null,"authors":["owner"],"capMicros":null,"helpers":[],"ineligibleHelpers":["owner"],"originator":"owner","phase":"SEEN","quorum":2,"rules":2,"seeHash":"ab8d81c97681e2b0f3e625b84408e51956365aebf8f2ebd47f54bb5a0e96e075","seeVersion":1,"specAuthor":null,"specHash":null,"spentMicros":0,"steward":"owner"}');
INSERT INTO "research_config"("source","enabled") VALUES('this_workspace',0);
INSERT INTO "search_docs"("item","seq","kind","author","hash","text") VALUES('memory',1,'posted','owner','ab8d81c97681e2b0f3e625b84408e51956365aebf8f2ebd47f54bb5a0e96e075','A note survives a transfer.');
INSERT INTO "worker_control"("id","killed") VALUES(1,0);
