# Closeout consumer report

Implemented a deterministic, no-model closeout consumer. It creates a content-addressed JSON artifact for each frozen stage post, records the artifact hash on `closeout_jobs`, and marks the job `done` atomically. The report has source sequence/body-hash references for facts, reported claims, spec assumptions and open questions, discussion and reconciliation status, original-attribution credits, decisions/reasons, unresolved frozen disagreements, and the next-stage link.

Erasing a source invalidates affected completed reports. The next consumer run creates a replacement report whose affected entry is marked erased, rather than exposing the prior text. `verifyAll()` now checks a completed report pointer against its deterministic snapshot reconstruction; rebuild preserves matching job state and artifact pointers.

Added the authenticated read-only `GET /api/items/:id/closeout/:post_id` endpoint and a JSON link on frozen post pages. Added migration 13 for the closeout artifact pointer. No model or network calls were added.

## Verification

- `node test/closeout.test.mjs`: 3/3 pass.
- `node test/stage-freeze.test.mjs`: 14/14 pass.
- `git diff --check`: pass.
- `npm test`: attempted once before the final verification-only refinement. It cannot complete in this sandbox because existing `test/gateway.test.mjs` loopback HTTP tests fail before their assertions with `listen EPERM: operation not permitted 127.0.0.1`. Gateway's 12 subtests had 7 pass and 5 environment failures. A final-diff suite attempt was also started, but this environment terminated the command after its 30-second execution window while the first 7 test files had passed. This is a sandbox listener restriction, not a product-test failure.

## Open questions

None that change the implemented behavior. The full-suite green gate and therefore the requested commit remain blocked by the sandbox's loopback-listener restriction.
