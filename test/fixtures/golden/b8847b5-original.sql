-- Golden fixture: schema and data written by commit b8847b5 (See / Spec / Send core/store.js).
-- Generated from a real database made by that commit's own Store, then dumped. Do not edit by hand.
CREATE TABLE actors(
        id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('person','gateway','run')),
        leader INTEGER DEFAULT 0, item TEXT NULL
      );
CREATE TABLE events(
        item TEXT, seq INTEGER, type TEXT, actor TEXT, body_hash TEXT,
        prev_hash TEXT, hash TEXT, at TEXT, idem TEXT,
        PRIMARY KEY(item,seq), UNIQUE(item,idem)
      );
CREATE TABLE bodies(hash TEXT PRIMARY KEY, bytes TEXT);
CREATE TABLE items(
        item TEXT PRIMARY KEY, state TEXT, head TEXT, seq INTEGER, context TEXT
      );
INSERT INTO "actors"("id","kind","leader","item") VALUES('member','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('steward','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('helper','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('other','person',0,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('leader','person',1,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('approver','person',1,NULL);
INSERT INTO "actors"("id","kind","leader","item") VALUES('gateway','gateway',0,'i');
INSERT INTO "actors"("id","kind","leader","item") VALUES('run','run',0,'i');
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem") VALUES('i',1,'checked','steward','41ae80aabdb709aa131192f77fa65691aa55a8e9936c936d14c26d841c51e055','','38c89cc95e7dfa3d933ddb5f64367d60621bb57005c503fe6ef147e4fe4841f9','2026-11-09T00:00:01.000Z','1');
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem") VALUES('i',2,'specced','steward','2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292','38c89cc95e7dfa3d933ddb5f64367d60621bb57005c503fe6ef147e4fe4841f9','d72ec4d7196d43749f7439879eeea70546a6fa12143ddfdb1980b216a187c3bb','2026-11-09T00:00:02.000Z','2');
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem") VALUES('i',3,'approved','approver','8a2f2250f5fd24f04565bc38fca703e3ed2da34a5f7d25510a188d280a069c90','d72ec4d7196d43749f7439879eeea70546a6fa12143ddfdb1980b216a187c3bb','d95e77966df115e51824658f9cfb90caa2b82444af87f221a424ff55c47c99e6','2026-11-09T00:00:03.000Z','3');
INSERT INTO "events"("item","seq","type","actor","body_hash","prev_hash","hash","at","idem") VALUES('j',1,'checked','member','c567d897cbc414a6d96786e3fd315c142639042d6bbb08d4ddcb8640e366efec','','188fb5b50cb74dfc994dcb94e7dc7738eb90890c582294be1ad6aa1b3e62c2b4','2026-11-09T00:00:04.000Z','4');
INSERT INTO "bodies"("hash","bytes") VALUES('41ae80aabdb709aa131192f77fa65691aa55a8e9936c936d14c26d841c51e055','{"found":[],"looked":["a setting"],"problem":"Synthetic golden problem","verdict":"build_needed"}');
INSERT INTO "bodies"("hash","bytes") VALUES('2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292','{"how_we_know":["two people confirm"],"must":["small try"],"out_of_scope":[]}');
INSERT INTO "bodies"("hash","bytes") VALUES('8a2f2250f5fd24f04565bc38fca703e3ed2da34a5f7d25510a188d280a069c90','{"cap_usd":1,"quorum":2,"spec_hash":"2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292"}');
INSERT INTO "bodies"("hash","bytes") VALUES('c567d897cbc414a6d96786e3fd315c142639042d6bbb08d4ddcb8640e366efec','{"found":[],"looked":["a sheet"],"problem":"Second synthetic item","verdict":"free"}');
INSERT INTO "items"("item","state","head","seq","context") VALUES('i','SENDING','d95e77966df115e51824658f9cfb90caa2b82444af87f221a424ff55c47c99e6',3,'{"approver":"approver","artifact":null,"cap":1,"helpers":[],"phase":"SENDING","quorum":2,"specHash":"2c8618e51135daaae03d925fafb616769429b5de7796671bba6de37111aad292","spent":0,"steward":"steward"}');
INSERT INTO "items"("item","state","head","seq","context") VALUES('j','CHECKED','188fb5b50cb74dfc994dcb94e7dc7738eb90890c582294be1ad6aa1b3e62c2b4',1,'{"approver":null,"artifact":null,"cap":null,"helpers":[],"phase":"CHECKED","quorum":2,"specHash":null,"spent":0,"steward":"member"}');
