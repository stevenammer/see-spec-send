-- Golden SQLite dump, PRAGMA user_version=7.
PRAGMA user_version=7;
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
CREATE INDEX login_failures_account ON login_failures(account, at);
INSERT INTO "actors"("id","kind","leader","item") VALUES('effort','agent',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('olive','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('maya','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('boss','person',1,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('42fe926795d3595e4d2d3add2d485529c3df40c1fe80cdf525b85eab9aa7a403','run',0,'golden-item');
INSERT INTO "actors"("id","kind","leader","item") VALUES('8f66e5cdbdfea49a8a254a97eace5ce02f4bce4eb642c825ff2e7630332cc29e','gateway',0,'golden-item');
INSERT INTO "bodies"("hash","bytes","erased") VALUES('72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4','{"original":"Callers lose context during transfer.","rules":2}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('75839e27376ac9bcce20980fa651921d1eacb703bbf3bd8cfe73faab91dae26f','{"anchor_hash":"72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4","anchor_kind":"see","comment":"Same thing happens on Fridays.","kind":"comment"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f','{"how_we_know":["A person reviews it"],"must":["Keep context"],"out_of_scope":[],"see_hash":"72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('772eafde1cf0aa1c12413ffd88319ea3e6f427db62221a64ee33af6efba1a5c2','{"specHash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('87749404dcb1c492afc298c9a993653804fb8c5243a85b58b28051f17fd6a592','{"packet_hash":"772eafde1cf0aa1c12413ffd88319ea3e6f427db62221a64ee33af6efba1a5c2","spec_hash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('b35167c062951351f83ecf7e7e67a1baf7dc4f3fc0ffa531a3eea0c4cc815310','{"cap_usd":1,"packet_hash":"772eafde1cf0aa1c12413ffd88319ea3e6f427db62221a64ee33af6efba1a5c2","quorum":1,"reason":"Small sandbox, independently reviewed.","spec_hash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('65e342488a2cd8da1d352a4565b0378cf9f0b09d95952d89175be9b4de9ce04a','<!doctype html><title>Small try</title><h1>Small try</h1><p>Fixture builder. No model wrote this.</p><p>Approved spec: 5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f</p><p></p>',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('8c0935c1ea942b425958caa045e425b47925087ed9aa2c590c79dc22e85095d5','{"approval":1,"artifact_hash":"65e342488a2cd8da1d352a4565b0378cf9f0b09d95952d89175be9b4de9ce04a","iteration":0,"model_output":false,"spec_hash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f"}',0);
INSERT INTO "effort_jobs"("id","item","kind","trigger_seq","requester","state","attempts","next_at","last_error","created") VALUES('7411057a654d60e8f09585341b1e24ca6370b353bec4d4c8522815217c9f5fc0','golden-item','see_first',1,'olive','queued',0,1794528001000,NULL,1794528001000);
INSERT INTO "effort_jobs"("id","item","kind","trigger_seq","requester","state","attempts","next_at","last_error","created") VALUES('defcaf3ced4042c791b9961674604d2a959ef4c0306addaa16b3c8c4df2cce51','golden-item','spec_draft',3,'olive','queued',0,1794528003000,NULL,1794528003000);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('golden-item',1,'posted','olive','72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4','','5c362ee91547ad2296a76a203338714a8cdfd14b65c69c41eea95eb5dc45ccf0','2026-11-13T00:00:01.000Z','g:1','681b4458af2dbf657d39ada2c0fc1b2b1a6a6893a63d19771c8cd7ce555f8011','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('golden-item',2,'commented','maya','75839e27376ac9bcce20980fa651921d1eacb703bbf3bd8cfe73faab91dae26f','5c362ee91547ad2296a76a203338714a8cdfd14b65c69c41eea95eb5dc45ccf0','720f5bcd7882471e9c5fa116beaff80f1489d545aa4a11e17bd923a8b245170b','2026-11-13T00:00:02.000Z','g:2','c479bdfc5d9a45e495b18281fede16e82965c7385c30ddecc5ed2f822420270d','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('golden-item',3,'specced','olive','5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f','720f5bcd7882471e9c5fa116beaff80f1489d545aa4a11e17bd923a8b245170b','57904e95626ba1d605cdbdf0baceb2fc5c49e5bb9847d5a4ecd385bf25b4b293','2026-11-13T00:00:03.000Z','g:3','4bfe2df73af95f72e99424a7f6dc4f188de6cd4318347d97ab1071c68957e6ee','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('golden-item',4,'sent','olive','87749404dcb1c492afc298c9a993653804fb8c5243a85b58b28051f17fd6a592','57904e95626ba1d605cdbdf0baceb2fc5c49e5bb9847d5a4ecd385bf25b4b293','2d6e7e4bda75a909a9499846749cd53fa7130507c5ae166592cd64df52239908','2026-11-13T00:00:04.000Z','g:4','2a308819289c213098ec380109fa8c80aa7e0e048c97285c705e60bd7e833e21','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('golden-item',5,'approved','boss','b35167c062951351f83ecf7e7e67a1baf7dc4f3fc0ffa531a3eea0c4cc815310','2d6e7e4bda75a909a9499846749cd53fa7130507c5ae166592cd64df52239908','403f0a47dd184d7caa012dba4de6cd02e98cd7a1ec162875d2e7c16ad1c6fe8e','2026-11-13T00:00:05.000Z','g:5','08de0f01ea35e9b59bfe6f8dfc6bd49b361cac26c2b1067930048e69f36f5c6e','person',1,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('golden-item',6,'tried','42fe926795d3595e4d2d3add2d485529c3df40c1fe80cdf525b85eab9aa7a403','8c0935c1ea942b425958caa045e425b47925087ed9aa2c590c79dc22e85095d5','403f0a47dd184d7caa012dba4de6cd02e98cd7a1ec162875d2e7c16ad1c6fe8e','2036d92aafb435ec5828d47f4ec4ecda17d6d3fef35896063efaa3e19e6cd486','2026-11-14T23:50:19.186Z','run:48b46c3cc9639abbc3a417926334872163bdbe44a4bd0af5816e7ae3e79eccd6:tried','18c79c06d8533e0e8885f474f712a8ca4e4e177934556cc95e42a0ff0c9e0b66','run',0,1);
INSERT INTO "fake_jobs"("id","input","html","status") VALUES('48b46c3cc9639abbc3a417926334872163bdbe44a4bd0af5816e7ae3e79eccd6','{"id":"48b46c3cc9639abbc3a417926334872163bdbe44a4bd0af5816e7ae3e79eccd6","item":"golden-item","approval":1,"iteration":0,"spec_hash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f","instructions":[],"cap_micros":1000000,"spec":{"must":["Keep context"],"how_we_know":["A person reviews it"],"out_of_scope":[]}}','<!doctype html><title>Small try</title><h1>Small try</h1><p>Fixture builder. No model wrote this.</p><p>Approved spec: 5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f</p><p></p>','ready');
INSERT INTO "gateway_integrity"("id","receipt_count") VALUES(1,0);
INSERT INTO "items"("item","state","head","seq","context") VALUES('golden-item','TRYING','2036d92aafb435ec5828d47f4ec4ecda17d6d3fef35896063efaa3e19e6cd486',6,'{"approval":1,"approver":"boss","artifact":"65e342488a2cd8da1d352a4565b0378cf9f0b09d95952d89175be9b4de9ce04a","authors":["olive"],"capMicros":1000000,"helpers":[],"ineligibleHelpers":["olive","boss"],"iteration":0,"originator":"olive","phase":"TRYING","quorum":1,"rules":2,"seeHash":"72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4","seeVersion":1,"sent":{"packetHash":"772eafde1cf0aa1c12413ffd88319ea3e6f427db62221a64ee33af6efba1a5c2","specHash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f"},"specAuthor":"olive","specHash":"5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f","specSeeHash":"72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4","specVersion":1,"spentMicros":0,"steward":"olive","superseded":false,"supersededArtifact":null}');
INSERT INTO "runs"("id","item","approval","iteration","spec_hash","run_actor","gateway_actor","status","delivered","started_at","see_hash") VALUES('48b46c3cc9639abbc3a417926334872163bdbe44a4bd0af5816e7ae3e79eccd6','golden-item',1,0,'5311f8679e4ae298677682cc03a351002abd253391cb11884b9c3833a3117c6f','42fe926795d3595e4d2d3add2d485529c3df40c1fe80cdf525b85eab9aa7a403','8f66e5cdbdfea49a8a254a97eace5ce02f4bce4eb642c825ff2e7630332cc29e','stop_requested',1,1794700219183,'72ffcf3700343b3df60c5c5f823b45f178a5aa3522f2e1b5f483687e09f148d4');
INSERT INTO "worker_control"("id","killed") VALUES(1,0);
INSERT INTO "worker_heartbeat"("id","at") VALUES(1,1794700219181);
