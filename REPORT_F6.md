# F6: current demo, explicit SPEC metadata, and optional private mentoring

The anonymous demo now starts with the current conversation: a SEE, fixture Effort first reply, thread, OP inclusion, living SPEC, frozen SEND packet, independent leader approval, fixture try, independent Helps, and a fork that cannot reuse parent approval. It uses the generated real state machine and fixed fictional roles. It does not pretend to have a database, sign-in, model, research source, or builder service. The earlier manual example is retained and labeled.

SPEC forms now expose assumptions and open questions, preserve them during comment inclusion, display out-of-scope requirements, and show historical version text and diffs. New fork seeds retain these fields under a stamped seed policy; earlier three-list seeds still import and replay unchanged.

Mentoring is opt-in and separate from work decisions. Both people must opt in; only the invited mentor accepts. Requests and check-ins are participant-only with no leader exception. Evidence is private by default and can be shared with the mentor or one explicitly named person. The owner can revoke sharing. Opting out closes active relationships and revokes owned evidence shares. Private notes do not enter work search, contribution indexes, decision packets or event exports. Host database administrators remain outside the application privacy boundary.

Schema 11 adds private tables. Golden schema-10 migration keeps workflow contexts and FTS contents intact. The golden-dump utility now excludes FTS shadow tables and round-trips the virtual table's content.

`npm run preview` starts a separate local fixture app with generated member/leader accounts and a private access file. It binds loopback, preserves its database across restarts, and refuses a second live preview lock. It calls no model vendor. It is a test preview, not a production deployment.

## Verification

The full suite passed 423/423 with zero skips. The core mentoring/HTTP permission tests, golden migration, current demo security tests, pure demo journey and real phone-width demo passed. The full app browser journey passed three-account mentoring, leader refusal, explicit sponsor evidence access and revocation. The listener, earlier manual browser journey, public-file check, generated demo parity and all 392 mutation-source checks passed. Eleven focused mutations failed on the intended behavioral assertions. The standard full-suite mutation release campaign remains pending before publication.

The larger goal remains open until the documented release gates and remaining required intelligence scope are resolved. No paid API was called.
