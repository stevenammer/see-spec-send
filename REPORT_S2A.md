# S2A report

## Changed

- Added migration 15 with an append-only `knowledge_log`, resumable `reanalysis_cursor`, and permanent reanalysis pair keys.
- Added `KnowledgeLog`, deterministic delta extraction, frozen-post matching, fixed-template annex records, receipts, and the bounded reanalysis runner.
- Added the workspace-wide `access/read.js` seam. Reanalysis checks it before matching and again before recording an annex.
- Kept item events untouched. Reanalysis writes only the separate knowledge log and its own projection tables. `core/machine.js` was not changed.

## Tests added

- `test/reanalysis-core.test.mjs`
  - knowledge chain verifies and detects tamper
  - agent authored text never becomes a delta
  - reanalysis is isolated per Store

## Tests run

- Passed: `node --test --test-concurrency=1 test/reanalysis-core.test.mjs test/closeout.test.mjs test/stage-freeze.test.mjs`
- Started `npm test`. The first fourteen suites passed, then `test/gateway.test.mjs` failed as a nested test process. Running it alone also fails without emitting a child assertion. This sandbox is known to reject loopback listeners with `EPERM`, so listener-dependent gateway coverage could not be completed here.

## Open questions

- This backend slice intentionally does not add digest/ping delivery, HTTP routes, frozen-page UI, renewal forks, or active-thread Effort replies.
- `knowledge_log` verification is exposed as `store.knowledge.verify()` rather than being folded into `verifyAll()` or replay/export. That avoids changing existing item-chain import and replay behavior.
