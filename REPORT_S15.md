# Slice 15 report: Tell the truth now

## Scope and assumptions

- This is a documentation-only slice. No application code, test, or mutant changed.
- The checkout started at `4699c2d502d0aa8540598b9a3b205d5dc3fb35e8`, the revision named by the production plan.
- The owner decisions supplied with the slice are future target state, not a claim that this revision already implements them.
- There were no open questions that changed the requested documentation scope.

## Failing-first output

No product test can be added or changed in this slice: the requested outcome explicitly requires no test change, and no new runtime control exists to mutate. Before changing documentation, I ran this read-only claim assertion against the five representative Section 2 overclaims:

```text
DOC-CLAIM ASSERTION FAILED: stale production claims remain
README.md: Bring-your-own-provider builders.
README.md: one-time password for the leader
docs/PROVIDERS.md: Configure the gateway's operator policy first.
docs/INTEGRATIONS.md: A signed retry is refused.
docs/THREAT_MODEL.md: Same generic login reply and scrypt work
```

The assertion passed after the edits. It was an ephemeral `node -e` documentation check, not a new test file.

## Code verification and documentation changes

I independently verified every Section 2 finding against `4699c2d` before editing. None was already wrong.

- `README.md` now separates the working manual/no-model/SQLite path from the built-but-not-usable provider builder, Quest model draft, identity-provider seam, and Postgres seam. It also corrects the API-rate-limit, worker wall-clock, backup-drill, integration-replay, CI-mutation, initial-password, and approval-handoff language.
- `docs/PROVIDERS.md` now says that no operator-policy CLI or provider-backed worker exists, slow holds can exhaust concurrency, Quest bypasses the provider boundary, and Bearer-token redaction is incomplete.
- `docs/QUICKSTART_ORG.md`, `docs/ADMIN.md`, `docs/WALKTHROUGH.md`, `docs/INTEGRATIONS.md`, and `docs/ADAPTER.md` correct the initial-password, empty-backup-drill, replay, Docker-token, and regex-filter claims.
- `docs/SLICE10_NOTES.md` and `docs/THREAT_MODEL.md` label identity-provider sign-in as not shipped and Postgres as not built.
- `docs/THREAT_MODEL.md` has a `Known gaps` section with one concise line for every blocker B1 through B28.

## Controls, tests, and mutants

None. This slice adds no implementation control and changes no test or mutant, as required. The existing controls and all entries in `scripts/mutate-check.mjs` are untouched.

## Verification run

```text
No section-2 stale excerpts found.
28

> seespecsend@0.0.1 check:public
> node scripts/check-public.mjs

PASS: tree and history checked (23 private denylisted terms, secret formats, private paths, personal emails, backup files).
```

## Tests not run in this sandbox

The following test files require a listener, Docker, or a real browser, all prohibited for this slice's sandbox:

- `test/gateway.test.mjs` (local HTTP listener)
- `test/provider.test.mjs` (local HTTP listener)
- `test/listener.smoke.mjs` (local listeners)
- `test/container.acceptance.mjs` (Docker and local listeners)
- `test/e2e/manual-path.e2e.mjs` (Chrome)
- `test/e2e/artifact-origin.e2e.mjs` (Chrome and local listeners)
- `test/e2e/vision-quest.e2e.mjs` (Chrome and a local listener)

I did not rerun the remaining ordinary unit tests or `check:mutants`, because no code, test, or mutant changed in this docs-only slice. A reviewer outside this sandbox should run `npm test`, `npm run check:mutants`, `npm run test:listen`, `npm run test:e2e`, `npm run test:artifact-origin`, and `npm run test:container` with the documented Docker, Chrome, and Playwright prerequisites. `npm run check:public` passed here.

## Outcome check

The Section 2 claims are gone or corrected at their cited documents, all four requested seams are in the explicit built-but-not-usable list with the missing pieces named, B1 through B28 appear once each in the threat model, no code or test was changed, and all changes remain uncommitted.
