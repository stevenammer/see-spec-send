# Slice 17 report: money can't leak

## Assumptions and open questions

- Fixed Quest defaults are three calls per person per UTC day, 256 output tokens per call, and 100,000 micro-dollars per person per UTC day.
- A provider failure is an ambiguous outcome, so its receipt remains a worst-case charged hold. A release keeps that charge unless the CLI caller explicitly asks for `--refund` and supplies a reason.
- The explicit `serve --enable-quest-model` flag is the requested preview opt-in. Without it, both signed-in Quest model routes are deliberately indistinguishable from absent routes.
- No open question changes the owner decisions or the Slice 17 outcome.

## Failing-first evidence

I ran the new opt-in proof against a temporary archive of `HEAD`, before the Slice 17 changes. It made no provider call and opened no listener.

```text
TAP version 13
# Subtest: model draft is 404 without an explicit serve-time opt-in
not ok 1 - model draft is 404 without an explicit serve-time opt-in
  ---
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    409 !== 404

  expected: 404
  actual: 409
```

The finished in-process Slice 17 test passes.

## Controls, proofs, and mutants

| Control | Proof | Mutant |
| --- | --- | --- |
| Quest model routes are unavailable unless the server explicitly installs the model service | `test/slice17.test.mjs`, opt-in route proof | `Quest model opt-in flag` |
| A Quest call checks the kill latch before provider invocation | `test/slice17.test.mjs`, counting provider proof | `Quest gateway kill latch` |
| Quest output is capped at 256 tokens and per-person calls and spend are capped per UTC day | `test/slice17.test.mjs`, counting provider proof | `Quest output ceiling`, `Quest person daily budget`, `Quest person daily spend budget` |
| Quest reservations use sealed receipts and count together with ordinary receipts against the gateway day and lifetime caps | `test/slice17.test.mjs`, day- and lifetime-cap proof | `Quest gateway day budget`, `Quest gateway lifetime budget` |
| `gateway policy set --file POLICY.json` appends a sealed policy version while existing receipt snapshots keep verifying | `test/slice17.test.mjs`, policy-version proof | `gateway policy version history` |
| `gateway holds list` and `gateway holds release --id --reason` are CLI operations; release emits a sealed audit and frees the concurrency slot while retaining worst-case charge | `test/slice17.test.mjs`, four-timeout recovery proof | `Quest hold release audit` |

## Verification completed

- `node --test --test-concurrency=1 test/slice17.test.mjs` passed.
- `npm test` passed: 216 tests, 0 failures, 0 skips.
- The explicit non-TTY mutation baseline command used by `scripts/mutate-check.mjs` passed: 171 tests, 0 failures, 0 skips.
- `npm run check:demo` passed. `core/machine.js` was not changed.
- `git diff --check` passed.

## Mutation-harness limitation in this sandbox

`node scripts/mutate-check.mjs --only 'gateway policy version history'` could not finish its own baseline here. It exits with `Baseline suite is not fully green with zero skipped tests.` and suppresses the child TAP details. The identical test argument list run directly exits 0 as recorded above. I did not claim any mutant as killed from this sandbox.

## Tests not run here and reviewer follow-up

These test files were not run because they require a prohibited listener, Docker, or unavailable Playwright dependency:

- `test/listener.smoke.mjs`
- `test/container.acceptance.mjs`
- `test/e2e/manual-path.e2e.mjs`
- `test/e2e/artifact-origin.e2e.mjs`
- `test/e2e/vision-quest.e2e.mjs` (attempted, blocked by `Cannot find module 'playwright'`)

A reviewer outside this sandbox must run `npm run check:mutants` and confirm all nine Slice 17 mutants above are killed. They should also run the listener, Docker acceptance, and browser suites in their supported environment. No external provider calls are part of this slice.
