-- Golden fixture: schema and data written by commit 4699c2d (See / Spec / Send core/store.js).
-- Generated from a real database made by that commit's own Store, then dumped. Do not edit by hand.
CREATE TABLE actors(
        id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run','source')),
        leader INTEGER DEFAULT 0, item TEXT NULL
      );
CREATE TABLE events(
        item TEXT, seq INTEGER, type TEXT, actor TEXT, body_hash TEXT,
        prev_hash TEXT, hash TEXT, at TEXT, idem TEXT, submitted_hash TEXT,
        actor_kind TEXT, actor_leader INTEGER, authority_version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(item,seq), UNIQUE(item,idem)
      );
CREATE TABLE bodies(
        hash TEXT PRIMARY KEY, bytes TEXT, erased INTEGER NOT NULL DEFAULT 0
      );
CREATE TABLE items(
        item TEXT PRIMARY KEY, state TEXT, head TEXT, seq INTEGER, context TEXT
      );
CREATE TABLE integration_sources(
        name TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, rate_limit INTEGER NOT NULL DEFAULT 30
      );
CREATE TABLE integration_replays(
        source TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(source,digest)
      );
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
CREATE TABLE worker_control(id INTEGER PRIMARY KEY CHECK(id=1), killed INTEGER NOT NULL);
CREATE TABLE worker_history(seq INTEGER PRIMARY KEY, action TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE runs(
      id TEXT PRIMARY KEY, item TEXT NOT NULL, approval INTEGER NOT NULL, spec_hash TEXT NOT NULL,
      run_actor TEXT UNIQUE NOT NULL, gateway_actor TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, started_at INTEGER, UNIQUE(item,approval)
    );
CREATE TABLE worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
CREATE TABLE fake_jobs(id TEXT PRIMARY KEY, input TEXT NOT NULL, html TEXT NOT NULL, status TEXT NOT NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('member','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('steward','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('helper','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('other','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('leader','person',1,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('approver','person',1,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('gateway','gateway',0,'i');
INSERT INTO "actors"("id","kind","leader","item") VALUES('run','run',0,'i');
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('i',1,'checked','steward','41ae80aabdb709aa131192f77fa65691aa55a8e9936c936d14c26d841c51e055','','20fa37e2df19ee5ce4943f24aed282c9cbf19b44c8513bc3b80ada391075e4ee','2026-11-09T00:00:01.000Z','1','9d6955b30f41bd8a1eeb54e635531dbd4f003a5d67714f56cb939de3c92285e3','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('i',2,'specced','steward','2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292','20fa37e2df19ee5ce4943f24aed282c9cbf19b44c8513bc3b80ada391075e4ee','95e888b0862dcb482f196176aca20f70db4044433d74663d2ff73c09c673da12','2026-11-09T00:00:02.000Z','2','59ff36e03b5eb97b92035d86fdca3ca04b4e4d2cac4ddbd7bfdb8b5c20da1d52','person',0,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('i',3,'approved','approver','8a2f2250f5fd24f04565bc38fca703e3ed2da34a5f7d25510a188d280a069c90','95e888b0862dcb482f196176aca20f70db4044433d74663d2ff73c09c673da12','d5eb5e8893bc7d476e9a1414bd8a38e59c2cc96eae096ac273bc3d18c2d99b24','2026-11-09T00:00:03.000Z','3','697355cb44e8abbb70886bcb28cc2feae627b501ba7f251af81bb5ad16559c06','person',1,1);
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem","submitted_hash","actor_kind","actor_leader","authority_version") VALUES('j',1,'checked','member','c567d897cbc414a6d96786e3fd315c142639042d6bbb08d4ddcb8640e366efec','','108a8b49fdcfa6ba0f955e35b97c38e6bb5884b44e10ad3bc9213d8a97f88506','2026-11-09T00:00:04.000Z','4','502890a0e427e8db51c73983ae91528c3268aa333f464bb5753cff94ffc1a4f8','person',0,1);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('41ae80aabdb709aa131192f77fa65691aa55a8e9936c936d14c26d841c51e055','{"found":[],"looked":["a setting"],"problem":"Synthetic golden problem","verdict":"build_needed"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292','{"how_we_know":["two people confirm"],"must":["small try"],"out_of_scope":[]}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('8a2f2250f5fd24f04565bc38fca703e3ed2da34a5f7d25510a188d280a069c90','{"cap_usd":1,"quorum":2,"spec_hash":"2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292"}',0);
INSERT INTO "bodies"("hash","bytes","erased") VALUES('c567d897cbc414a6d96786e3fd315c142639042d6bbb08d4ddcb8640e366efec','{"found":[],"looked":["a sheet"],"problem":"Second synthetic item","verdict":"free"}',0);
INSERT INTO "items"("item","state","head","seq","context") VALUES('i','SENDING','d5eb5e8893bc7d476e9a1414bd8a38e59c2cc96eae096ac273bc3d18c2d99b24',3,'{"approval":1,"approver":"approver","artifact":null,"capMicros":1000000,"helpers":[],"ineligibleHelpers":["steward","approver"],"phase":"SENDING","quorum":2,"specHash":"2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292","spentMicros":0,"steward":"steward"}');
INSERT INTO "items"("item","state","head","seq","context") VALUES('j','CHECKED','108a8b49fdcfa6ba0f955e35b97c38e6bb5884b44e10ad3bc9213d8a97f88506',1,'{"approval":0,"approver":null,"artifact":null,"capMicros":null,"helpers":[],"ineligibleHelpers":["member"],"phase":"CHECKED","quorum":2,"specHash":null,"spentMicros":0,"steward":"member"}');
INSERT INTO "worker_control"("id","killed") VALUES(1,0);
