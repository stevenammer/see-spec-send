# Bundle origin report

## What changed

- OpenCode ready results now retain the existing script-free HTML fallback and add a canonical `sss_bundle` artifact containing the validated manifest and base64 files.
- The runner stores that bundle artifact and still marks its `tried` event as model output.
- Added hash-prefix artifact lookup and a separate, HMAC-labelled bundle server. It accepts only GET/HEAD, serves manifest files only, and applies the requested no-network CSP and response headers.
- Configured item pages use the separate-origin playable iframe; without that server, the existing script-free artifact route and `MODEL_TRY_CSP` remain in use.
- Added `serve --bundle-port` and `--bundle-host-suffix`, random per-process signing material, documentation, unit coverage, and the Playwright journey plus CI command.

## Deviations

- No database migration was needed: the feature stores its bytes in the existing artifact body table and adds no schema.
- The app page CSP names the exact generated bundle origin for that item, which is narrower than a host-suffix wildcard.

## Tests

- Passed: `node --test test/opencode-adapter.test.mjs test/builder-adapter-contract.test.mjs test/bundle-origin.test.mjs test/bundle-html.test.mjs test/slice25.test.mjs test/slice19.test.mjs`
- Passed earlier scoped checks: `test/bundle-html.test.mjs`, syntax checks, `git diff --check`, and the core Date/Math scan (the reported existing uses are outside this change).
- Not run to completion: the first `npm test` attempt was invalidated by a syntax error in the newly edited OpenCode adapter, fixed afterward. The full suite was not rerun in this turn.
- Not run: `npm run test:bundle-origin` cannot start here because Playwright is not installed (`Cannot find module 'playwright'`). The browser test is written for the CI-provided external Playwright install. This sandbox's loopback restriction was therefore not reached in that test.

## Open questions

- The browser journey still needs its CI/outside-sandbox run with Playwright installed.
