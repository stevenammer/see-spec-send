# Slice 16 report: blocked by preserved test contracts

## Assumptions and open questions

- The owner decision is literal: anyone who has ever been the steward or authored a spec for an item is permanently ineligible to approve that item.
- `expected_seq` is the item event sequence the leader saw when the Decide page rendered. `spec_hash` is the current spec body hash shown on that same page.
- Account IDs are local human account IDs, so the conservative v1 grammar is lowercase ASCII `[a-z][a-z0-9._-]{0,63}`. `source:`, `oidc-`, and 64-hex namespaces are unavailable to those IDs.
- Open question for the reviewer: should legacy story fixtures and their expected output now be updated to reflect the approved permanent separation rule? Existing test files must remain unchanged under this task's rules.

## Failing-first output

The new test was added first in `test/slice16.test.mjs`. Before the implementation it failed as follows:

```text
not ok 1 - Decide renders the current escaped spec and approval binds the seen hash and sequence
error: The input did not match the regular expression /show &lt;this&gt;/

not ok 2 - HTTP event schemas reject unknown, oversized, erased, and forged delivery names without writing
error: Expected values to be strictly equal: 201 !== 409

not ok 3 - actor registration preserves kind and account IDs cannot collide or vary by case
error: Missing expected rejection.

not ok 4 - a steward or spec author cannot approve the item
error: The expression evaluated to a falsy value
```

After the implementation, `node --test --test-concurrency=1 test/slice16.test.mjs` passed 4/4.

## Implemented controls

- B1: Decide renders the escaped current spec in SPECCED, SENDING, and TRYING. Its approve form carries the rendered `spec_hash` and `expected_seq`; browser code sends both; HTTP no longer fills either in. The store's existing optimistic sequence check rejects a respec race.
- B2: HTTP event input now uses an allowlist per permitted client event type, rejects unknown fields and bounded-field violations before a write, forbids `erased`, and cannot accept `delivered_by`. The history only honors `delivered_by` for server-written `tried` events.
- B3: Account IDs now use the conservative local grammar and reserve source, OIDC, and token-looking namespaces. User creation and invite redemption reject case-insensitive user collisions. Actor registration refuses a kind change for person, source, gateway, and run actors.
- B4: Machine approval now also rejects every actor in `ineligibleHelpers`, which records stewards and spec authors. `npm run sync:demo` was run and `npm run check:demo` is green.

## Required mutants

No Slice 16 mutants were added because the required full-suite gate is blocked by preserved existing tests described below. Adding mutants before that conflict is resolved would not satisfy the requested done condition.

## Blocking preserved tests

`npm test` was run. It failed because these existing tests expect the behavior the owner decision prohibits:

- `test/worker.test.mjs`, “spec replacement and new approval fence old tokens even with forged current binding”, fails with `event not allowed` when its prior spec author is reused as approver.
- `test/gateway.test.mjs`, “late usage settles the original approval after respec, new approval, kill and UTC rollover”, fails for the same prior-author approval.
- `test/demo-parity.test.mjs`, story `stale-approval`, expects the same formerly permitted approval. Before demo sync it also reported the expected generated-copy drift; `sync:demo` corrected that copy and `check:demo` passes.
- `test/auth.test.mjs`, “events reject client authority, tokens, self approval, and require fresh single-use step-up”, expects HTTP approval without the newly required `spec_hash` and `expected_seq` fields.

I did not edit, weaken, skip, rewrite, or delete any existing test or mutant. These failures block completion under the task instructions. A reviewer must decide whether the old tests and story fixture are intentionally updated to the owner-approved Slice 16 contract.

## Commands run

- `node --test --test-concurrency=1 test/slice16.test.mjs` (failed first, then passed 4/4)
- `npm test` (blocked by the four existing-contract failures above)
- `npm run sync:demo` (passed)
- `npm run check:demo` (passed)

## Not run in this sandbox

- `test/listener.smoke.mjs` via `npm run test:listen`, prohibited because this task forbids listeners.
- `test/e2e/manual-path.e2e.mjs` via `npm run test:e2e`, not run because it requires a real listener/browser path.
- `test/e2e/artifact-origin.e2e.mjs` via `npm run test:artifact-origin`, not run because it requires a real listener/browser path.
- `test/container.acceptance.mjs` via `npm run test:container`, prohibited because this task forbids Docker.
- `test/check-public.test.mjs`, not run separately.
- `npm run check:mutants`, not run because Slice 16 mutants cannot be validly completed until the preserved-test contract conflict is resolved.

## Reviewer handoff

Outside this sandbox, first resolve the four preserved-contract failures without weakening tests. Then add and run one killing mutant per B1 through B4, run `npm test`, `npm run check:mutants`, the listener and browser paths, and the Docker acceptance suite.
