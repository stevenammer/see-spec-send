# Status

An honest table. A row says **Shipped and tested** only when a named test in this repository covers it. Words: Shipped and tested, Built (fixture only), Built (not verified live), Planned, Not planned.

| Capability | Status | Evidence | Limits |
| --- | --- | --- | --- |
| SEE, SPEC, SEND workflow with frozen stages | Shipped and tested | `test/stage-freeze.test.mjs`, `test/vision-03.test.mjs` | Local SQLite store |
| Nine decision outcomes | Shipped and tested | `test/decision-outcomes.test.mjs` | Older generic no's stay unclassified |
| Fork on disagreement, decline, 14-day window | Shipped and tested | `test/reconcile.test.mjs` | Unavailable-author path not built |
| Stewardship transfer | Shipped and tested | `test/steward-transfer.test.mjs` | A leader decides the transfer |
| Closeout reports | Shipped and tested | `test/closeout.test.mjs` | Template-based, no analysis, correction path planned |
| Private opt-in mentoring | Shipped and tested | `test/sliceF6-mentoring.test.mjs` | Not wired to anything else, by design |
| Guided problem discovery | Shipped and tested | `test/vision-quest.test.mjs` | AI lane is a fixture unless an operator configures one |
| Metered model gateway and chat proxy | Shipped and tested | `test/gateway.test.mjs`, `test/proxy-chat.test.mjs` | Dollar caps, plus optional per-run call and token ceilings (`test/gateway-run-limits.test.mjs`) so a free model is bounded too |
| Static-page builder in a locked container | Built (fixture only) | `test/builder.test.mjs`, `test/container.test.mjs` | One-shot static HTML, verified against a local mock |
| Real coding agent through the metered proxy | Built (live trial on a synthetic task) | `test/bedrock.test.mjs`, `test/proxy-chat.test.mjs`, `scripts/builder-trial.mjs` | One open-source agent wrote a small multi-file page with every call metered. This is a trial, not a benchmark. Running it inside the locked container as a registered builder is not built yet |
| Continuous reanalysis (new internal results checked against earlier work; linked updates; new-decision path) | Shipped and tested | `test/reanalysis-scenarios.test.mjs`, `test/reanalysis-delivery.test.mjs`, `test/e2e/reanalysis-journey.e2e.mjs` | Internal results only, deterministic matching (no model). Updates appear on frozen cases; an open discussion does not receive them yet. Run from the CLI; no scheduler
| Working ledger and sourced estimates | Shipped and tested | `test/ledger.test.mjs`, `test/estimate.test.mjs` | Estimates come from the gateway policy, prior builds and author judgment, labeled as such; they never set the approved cap. Statuses change only when the steward revises the SPEC |
| Private reflection after decisions | Shipped and tested | `test/reflection.test.mjs` | Notes stay in the person's browser only; they do not follow the person across devices |
| Departments and read scopes | Planned | none | Every workspace member can read work posts today |
| Opportunity propagation | Planned | none | Not started |
| Correctable derived memory | Planned | none | Source erasure exists; derived records do not yet exist |
| Microsoft Teams and other channels | Planned | none | Nothing shipped |
| Customer-owned storage, enterprise sign-in | Planned | none | Seams only |
| Scoring or ranking people | Not planned | none | |

Tests run on Node 22. See the [roadmap](ROADMAP.md) for order and the [decisions](DECISIONS.md) for why.
