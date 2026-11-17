# S7 report

Implemented the saved, re-runnable Investigate path.

- `intelligence/run.js` builds scoped evidence packages before any model seam, saves append-only `analysis_receipt` and `analysis_challenge` records, rechecks access on receipt delivery, and uses a sources-only deterministic fallback by default.
- Ranking, weakest-link, and motive-inference prompts receive a fixed criteria, outcomes, and unknowns reframe. Model output that attempts the same is refused.
- `gateway/analysis.js` is an opt-in, daily-capped `analysis` job class. The HTTP handler only uses it when injected by an operator; otherwise no model provider is called.
- Migration 19 adds `knowledge_bodies` and `gateway_analysis_receipts`; `test/slice21.test.mjs` now expects schema 19.
- Added `test/analysis-run.test.mjs` for all five S7 acceptance cases, including the model-output paraphrase tripwire.

Verification passed:

`node --test test/analysis-run.test.mjs test/sliceF8-evidence.test.mjs test/sliceF8-http.test.mjs test/slice21.test.mjs`

`test/reanalysis-core.test.mjs`, `test/reanalysis-scenarios.test.mjs`, and `test/reanalysis-delivery.test.mjs` also passed in the focused regression run.

I did not claim the full suite passed. `npm test` and `test/gateway.test.mjs` cannot complete in this sandbox because its HTTP cases fail to bind `127.0.0.1` with `listen EPERM`; those cases include gateway HTTP settlement, concurrent HTTP reservations, hostile HTTP limits, and API budget exposure. No network or paid provider was used. No commit or push was made.
