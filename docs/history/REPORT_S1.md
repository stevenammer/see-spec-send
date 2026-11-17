# S1 report: working ledger and sourced estimates

## What changed

- Added rules-3-only `specced.ledger` and `specced.estimates` normalization and validation. Ledger IDs are stable across revisions, text must remain in the matching assumptions or open-questions array, and estimates without a basis are recorded as author judgment.
- Added `knowledge/ledger.js` for the rebuildable `ledger_entries` projection and `knowledge/estimate.js` for pure range helpers. No model or network lane was added.
- Added migration 14 for the derived `ledger_entries` table.
- Added packet v3 for rules-3 sends, including ledger entries, open questions, and unverified assumptions. Legacy packet construction remains v2 and does not gain new fields.
- Added ledger IDs/statuses to closeout reports.
- Added a SPEC working-ledger panel, answer comments, steward status/link controls, and an estimate entry form.
- `core/machine.js` and `demo/lib/*` were not changed. No sync was needed.

## Tests added

- `ledger entry keeps its id across spec revisions`
- `comment resolves claim does not change status until steward revises`
- `ledger text must match the spec arrays`
- `rules 2 item refuses ledger fields; legacy replay and hashes verify`
- `packet v3 lists open questions and unverified assumptions; v2 packet hash unchanged`
- `closeout report carries ledger ids and statuses`
- `estimate without a basis is labeled author judgment`
- `estimate never sets or raises the approval cap`
- `fewer than three priors says too few prior builds`

## Tests run

- Passed: `node --test --test-concurrency=1 test/ledger.test.mjs test/estimate.test.mjs test/slice21.test.mjs test/sliceF7-spec.test.mjs`
- Passed earlier in the broader non-listener run through `test/slice20.test.mjs`; it also included auth, closeout, decision, demo, hardening, legacy migration, machine, page, reconciliation, and security coverage.
- `git diff --check` passed.

## Tests not completed

- The full `npm test` suite could not complete in this sandbox. `test/gateway.test.mjs` failed where it opens a real `127.0.0.1` listener. Its local helper does not surface the listener error, but this environment is documented to block loopback listeners with `EPERM`.
- `test/slice22.test.mjs` also failed in its multi-process 20-second soak path. It does not print the child failure detail under Node's file-level test wrapper, so it has not been claimed as passing.
- Listener-dependent tests were not run to completion for the same sandbox constraint.

## Open questions

- The request names a gateway-policy build-spend range. S1 provides pure `gatewayRange` and prior-charge helpers, but the existing SEND route currently supplies no selected gateway policy to the packet. Wiring a configured policy into that route would change gateway configuration behavior and needs a follow-up decision.
- S1 records a coworker's answer as a claim; only the steward's later SPEC revision changes the question status, as required.
