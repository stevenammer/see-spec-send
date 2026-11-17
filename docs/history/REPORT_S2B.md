# S2B report

Implemented the delivery half of reanalysis without changing `core/machine.js`.

- Added append-only digest entries, daily ping ledger, mute state, and `deliverAnnexes` in `notifications/digest.js`. Recipients are derived from the recorded steward, original author, and decision actors only.
- `runReanalysis` now performs idempotent digest delivery after annex recording.
- Added authenticated, read-gated updates, digest, annex-response, and renewal routes. Responses append to the knowledge log. Mute does not remove annexes. A steward's not-relevant response removes only that person's digest entry.
- Added frozen-page update rendering outside the frozen thread, escaped AI disclosure and update fields, plus response controls and item-page renewal controls.
- Renewal forks validate their annex, target, actor, content, and one-per-annex-per-person rule. They do not use the disagreement eligibility gate.
- Packet v3 accepts and emits `prior_decision` and `new_information` for renewal branches.
- Added `reanalysis run [--limit N]` CLI command and administrator documentation. No scheduler was added.
- Documented that active-thread reanalysis is out of scope and the matcher targets frozen posts only.

Verification run:

- `node --check cli.js app/http.js app/pages.js public/app.js`
- `node --test test/reanalysis-scenarios.test.mjs test/sliceF4-forks.test.mjs`
- `git diff --check`

The targeted tests passed. The full `npm test` run reached `test/gateway.test.mjs` and could not complete its loopback HTTP cases because this sandbox refuses `listen` with `EPERM` on `127.0.0.1`. The affected gateway test names were `gateway HTTP settles exact integer micros and persists only credential digests`, `100 barrier HTTP calls one cent below cap never forward refused reservations`, `concurrent duplicates get one outcome or honest unresolved hold without redispatch`, `server validates hostile limits, model prices, payload keys, capability scope and expiry`, and `CLI status and API budget expose original approval holds separately from legacy events`. This is environment blocking, not a failure attributed to S2B.

Open question: the existing test suite directly inserts six-column legacy rows into `lineage`. To preserve that compatibility, derived renewal/disagreement relation is persisted in `lineage_relations` alongside the original lineage projection rather than adding a seventh physical column to `lineage`; it is rebuilt with lineage. If a schema-breaking lineage column is required, the legacy direct-SQL compatibility test and any external consumers will need a coordinated migration.
