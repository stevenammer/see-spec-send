# Model lanes report

Implemented the optional Bedrock and advisory reanalysis lanes without changing
`core/machine.js` or adding a scheduler.

- `bedrock` is a provider kind. Its file accepts region, model ID, enabled state,
  and reviewed per-million-token prices. AWS credentials are rejected from the
  file and read only from the process environment when a call is made.
- `serve --analysis-provider NAME` is opt-in. Without the flag, organizational
  analysis remains sources-only. A disabled provider refuses before a listener
  or call is made.
- `reanalysis run --verify --analysis-provider NAME` uses the existing daily
  capped analysis gateway. The optional check can hold a deterministic match or
  attach bounded uncertainty to its new annex. Invalid JSON, unsafe language,
  citation mismatches, and failures leave the deterministic result alone.

Verification completed with Node 22:

- `node test/model-lanes.test.mjs` passed.
- `node test/reanalysis-verify.test.mjs` passed.
- `npm run check:public` passed.
- `git diff --check` passed.

The full `npm test` run did not pass in this sandbox. `test/gateway.test.mjs`
cannot bind `127.0.0.1` and reports `listen EPERM: operation not permitted`.
The same restriction also prevents the listener portions of `test/provider.test.mjs`.
No network, real provider, tenant, or credential test was run.
