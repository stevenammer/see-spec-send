# S5 report

Implemented correctable derived memory without changing `core/machine.js` or rewriting event hashes.

- Schema 19 adds content-addressed `knowledge_bodies`, source-to-derived dependency rows, and immutable derived-record tombstones.
- Erasing an event body now tombstones dependent deltas and annexes, records append-only `retraction` log entries, clears matching digest delivery, marks the source knowledge body erased, and requeues affected closeouts in the same transaction.
- Attributed `correction` entries can challenge a source or derived claim. A challenged delta is excluded from deterministic matcher support. Neither correction nor retraction changes the source event chain.
- Added a read-scoped typed Knowledge index for decisions, assumptions, questions, results, and disconnected research sources.
- Added a readable escaped closeout page, linked from frozen posts, with an attributed “This is wrong / Add context” control.
- Updated status and frozen-copy documentation.

Verification:

- Passed: `node --test test/corrections.test.mjs test/knowledge-index.test.mjs test/closeout.test.mjs test/reanalysis-core.test.mjs test/reanalysis-delivery.test.mjs test/slice21.test.mjs`.
- `npm test` was attempted. It cannot complete in this sandbox because `test/gateway.test.mjs` has five HTTP cases that fail before assertions with `listen EPERM: operation not permitted 127.0.0.1`. Those are the tests not run successfully here. No full-suite pass is claimed.
- `git diff --check` passed. `core/store.js` and `core/migrations.js` contain no new `Date.` or `Math.random` calls.
