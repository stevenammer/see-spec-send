# Slice 11 to 12 wiring report

## Assumptions

- An administrator starts the gateway with the same organization default that
  the container adapter reads. `provider default --org ORG --name NAME` records
  that choice. No enabled default means the fixture remains the builder model.
- The gateway policy has already been fixed before a provider gateway starts.
- A provider's integer price table is the organization's reviewed estimate, not
  a vendor invoice.

## What changed

- The container adapter resolves an enabled organization default to its reviewed
  model name and passes only that non-secret model name to the builder.
- The gateway server uses the configured provider upstream and a fixed static
  page system instruction. Provider credentials remain in the gateway process.
- The builder sends only `must`, `how_we_know`, and `out_of_scope` as its user
  content. It strips surrounding model commentary or fences, validates the
  static page, allows one separately metered repeat request, then fails.
- Container-delivered tries are marked `model_output` and the work log says
  “model output”. The command reports provider, model, and conservative
  worst-case micro-dollar hold before approval.

## Per-control proof

| Control | Proof |
| --- | --- |
| Fixture stays default | `ContainerAdapter` uses `fixture:text-v1` unless an enabled org default is present. |
| Provider key boundary | `test/container.test.mjs` checks provider-secret text is absent from Docker arguments, environment entries, and bind mounts. Provider adapters retain the key only on the gateway host. |
| Cap, reservation, settlement, idempotency, kill | Existing `gateway/ledger.js` remains the sole admission and settlement path. No control was bypassed. |
| Model output validation | `test/builder.test.mjs` proves deterministic extraction and script rejection. |
| Model label | `Worker.deliver` records `model_output`; `app/pages.js` renders it. |
| New mutants | `container gateway model binding` and `builder markdown extraction` were added to `scripts/mutate-check.mjs`. |

## Verification

- Passed in this checkout with Node 22: the suite reached and passed all files
  through `test/demo-safety.test.mjs`, including new `test/builder.test.mjs` and
  `test/container.test.mjs`.
- Not verified here: gateway HTTP tests need a local loopback listener. This
  restricted sandbox returns `EPERM` for `127.0.0.1`, so `test/gateway.test.mjs`
  cannot complete here. Its existing local mock coverage includes success,
  caps, missing usage, idempotency, and stop/kill cases.
- Not verified here: `npm run test:container`. It requires the real Docker
  daemon outside this sandbox. The existing acceptance test is intentionally
  non-skipping and will fail loudly without its pinned image.
- Unverified UI detail: the approval page states the gateway administrator must
  review the printed provider/model/worst-case amount. It does not yet fetch
  that data into the browser approval form. The CLI command is the source of
  truth for that preflight display.

## Remaining review points

- Run `npm test`, `npm run check:mutants`, and `npm run test:container` on the
  unrestricted host. Use only a local mock provider for those tests.
- Before an actual vendor smoke, follow the live-smoke checklist in
  `docs/PROVIDERS.md` and read the command's printed worst-case hold.
