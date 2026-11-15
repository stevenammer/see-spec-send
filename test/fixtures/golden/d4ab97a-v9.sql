-- Golden SQLite dump, PRAGMA user_version=9.
PRAGMA user_version=9;
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
CREATE TABLE runs(
          id TEXT PRIMARY KEY, item TEXT NOT NULL, approval INTEGER NOT NULL, iteration INTEGER NOT NULL DEFAULT 0,
          spec_hash TEXT NOT NULL, run_actor TEXT UNIQUE NOT NULL, gateway_actor TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, started_at INTEGER, see_hash TEXT,
          UNIQUE(item,approval,iteration)
        );
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
CREATE INDEX lineage_parent ON lineage(parent_item);
CREATE INDEX login_failures_account ON login_failures(account, at);
INSERT INTO "actors"("id","kind","leader","item") VALUES('effort','agent',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('originator','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('forker','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('leader','person',1,NULL);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('fafaeecf6a96f6d1b333e79985e70cab46009ae8d98053e3eea36930c3bbc666','{"original":"A caller repeats the note after transfer.","rules":2}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187','{"how_we_know":["Transfer retains the note"],"must":["Keep the note"],"out_of_scope":["External services"],"see_hash":"fafaeecf6a96f6d1b333e79985e70cab46009ae8d98053e3eea36930c3bbc666"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('c7df83170b6a94218f17c24673726f6b02debd33332f29182ed51a5cf7635aa9','{"specHash":"fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('5426bc1886c273c54cc7b6a8b76390618a34920d5df5177749b1eff4a00f0eab','{"packet_hash":"c7df83170b6a94218f17c24673726f6b02debd33332f29182ed51a5cf7635aa9","spec_hash":"fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('5b6bf67cc1ac78d2508f5e79b5aaba397a6f19b7ad1d5778ec1a63e434fb7bd2','{"cap_usd":1,"max_iterations":2,"packet_hash":"c7df83170b6a94218f17c24673726f6b02debd33332f29182ed51a5cf7635aa9","quorum":1,"reason":"A bounded note-preservation trial is useful.","spec_hash":"fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187","window_minutes":60}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('050e5841f410c7e4de5f8bf1833bd26b00e05b2e8b390932f7cb9749fa73e5f9','{"original":"A smaller note-preservation trial.","parent":{"hash":"16eebffb5f69c4e6e8d02c83403b95d62e5f0a65aa658d59c594cee7d575bc2a","item":"parent","seq":4},"reason":"Try a smaller note view.","rules":2}',0);
INSERT INTO "effort_jobs"("id","item","kind","trigger_seq","requester","state","attempts","next_at","last_error","created") VALUES('7eee36915e75c8abc4f9f6831124929e345222bda09ac739e5fd80ea14482733','parent','see_first',1,'originator','queued',0,1794657601000,NULL,1794657601000);
INSERT INTO "effort_jobs"("id","item","kind","trigger_seq","requester","state","attempts","next_at","last_error","created") VALUES('da360663e63a3ea7a6a890d8ee62c79e4ab86c284a5844131d6c03ce5c42cbb2','parent','spec_draft',2,'originator','queued',0,1794657602000,NULL,1794657602000);
INSERT INTO "effort_jobs"("id","item","kind","trigger_seq","requester","state","attempts","next_at","last_error","created") VALUES('68465e0d09453104240ae3ff05077cf4786ef720ae0ca5cd4559e9067a4162dc','child','see_first',1,'forker','queued',0,1794657605000,NULL,1794657605000);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('parent',1,'posted','originator','fafaeecf6a96f6d1b333e79985e70cab46009ae8d98053e3eea36930c3bbc666','','ee65493384640cea44324789330e735dfb684eade58e8ab815f7987df08299e7','2026-11-14T12:00:01.000Z','golden:1','ddd12fabea780776a4f93e6926d8205c064ccb23aff7b1f356374f5ffc9dcbb8','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('parent',2,'specced','originator','fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187','ee65493384640cea44324789330e735dfb684eade58e8ab815f7987df08299e7','882a8e94457a1bee0aee1a0c58a7721fabe5b41b6b133565d89ef0e65b4550eb','2026-11-14T12:00:02.000Z','golden:2','3ada61e5672c318023c7893c5285300ceca0bb6d11ba8d75bc90633f2d328eed','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('parent',3,'sent','originator','5426bc1886c273c54cc7b6a8b76390618a34920d5df5177749b1eff4a00f0eab','882a8e94457a1bee0aee1a0c58a7721fabe5b41b6b133565d89ef0e65b4550eb','94109e6ed1db07ba0c5cf094e6441b2a7cc7dadeb473848ca7bea78a26b6b1b4','2026-11-14T12:00:03.000Z','golden:3','7cb3cec3a9a932d621028e0a45357bab58658c4acd638834dbbec71e81e2862e','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('parent',4,'approved','leader','5b6bf67cc1ac78d2508f5e79b5aaba397a6f19b7ad1d5778ec1a63e434fb7bd2','94109e6ed1db07ba0c5cf094e6441b2a7cc7dadeb473848ca7bea78a26b6b1b4','16eebffb5f69c4e6e8d02c83403b95d62e5f0a65aa658d59c594cee7d575bc2a','2026-11-14T12:00:04.000Z','golden:4','fc3e5f83d396ce4f1a64379575e3c2fe87f4d7cd6e442331f04973e5709943f1','person',1,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('child',1,'forked','forker','050e5841f410c7e4de5f8bf1833bd26b00e05b2e8b390932f7cb9749fa73e5f9','','be77b6568bddcf723ba19fc42fc74278106c146f36767c7b8eeac9c9b35ed8cf','2026-11-14T12:00:05.000Z','golden:5','07d088edb1ff4ad0ca66710d307d248ea13bac40c12ef1488d16f93f610fb8b5','person',0,1);
INSERT INTO "gateway_integrity"("id","receipt_count") VALUES(1,0);
INSERT INTO "items"("item","state","head","seq","context") VALUES('parent','SENDING','16eebffb5f69c4e6e8d02c83403b95d62e5f0a65aa658d59c594cee7d575bc2a',4,'{"approval":1,"approver":"leader","artifact":null,"authors":["originator"],"capMicros":1000000,"decided":{"actor":"leader","at":"2026-11-14T12:00:04.000Z","disposition":"approved","packetHash":"c7df83170b6a94218f17c24673726f6b02debd33332f29182ed51a5cf7635aa9","reason":"A bounded note-preservation trial is useful.","specHash":"fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187"},"helpers":[],"ineligibleHelpers":["originator","leader"],"iteration":0,"leash":{"expiresAt":"2026-11-14T13:00:04.000Z","maxIterations":2,"windowMinutes":60},"originator":"originator","phase":"SENDING","quorum":1,"rules":2,"seeHash":"fafaeecf6a96f6d1b333e79985e70cab46009ae8d98053e3eea36930c3bbc666","seeVersion":1,"sent":{"packetHash":"c7df83170b6a94218f17c24673726f6b02debd33332f29182ed51a5cf7635aa9","specHash":"fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187"},"specAuthor":"originator","specHash":"fa0dcff88bd96f504ab4ffd0f9e6ff4130ded3d2af1e1f2da423b751e8bc0187","specSeeHash":"fafaeecf6a96f6d1b333e79985e70cab46009ae8d98053e3eea36930c3bbc666","specVersion":1,"spentMicros":0,"steward":"originator","superseded":false,"supersededArtifact":null}');
INSERT INTO "items"("item","state","head","seq","context") VALUES('child','SEEN','be77b6568bddcf723ba19fc42fc74278106c146f36767c7b8eeac9c9b35ed8cf',1,'{"approval":0,"approver":null,"artifact":null,"authors":["forker"],"capMicros":null,"helpers":[],"ineligibleHelpers":["forker"],"originator":"forker","parent":{"hash":"16eebffb5f69c4e6e8d02c83403b95d62e5f0a65aa658d59c594cee7d575bc2a","item":"parent","seq":4},"phase":"SEEN","quorum":2,"rules":2,"seeHash":"050e5841f410c7e4de5f8bf1833bd26b00e05b2e8b390932f7cb9749fa73e5f9","seeVersion":1,"specAuthor":null,"specHash":null,"spentMicros":0,"steward":"forker"}');
INSERT INTO "lineage"("child","parent_item","parent_seq","parent_hash","source_kind","source_body_hash") VALUES('child','parent',4,'16eebffb5f69c4e6e8d02c83403b95d62e5f0a65aa658d59c594cee7d575bc2a',NULL,NULL);
INSERT INTO "worker_control"("id","killed") VALUES(1,0);
