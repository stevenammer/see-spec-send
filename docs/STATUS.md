# Status

An honest table. A row says **Shipped and tested** only when a named test in this repository covers it. Words: Shipped and tested, Built (fixture only), Built (not verified live), Planned, Not planned.

| Capability | Status | Evidence | Limits |
| --- | --- | --- | --- |
| SEE, SPEC, SEND workflow with frozen stages | Shipped and tested | `test/stage-freeze.test.mjs`, `test/vision-03.test.mjs` | Local SQLite store |
| Nine decision outcomes | Shipped and tested | `test/decision-outcomes.test.mjs` | Older generic no's stay unclassified |
| Fork on disagreement, decline, 14-day window | Shipped and tested | `test/reconcile.test.mjs` | Unavailable-author path not built |
| Stewardship transfer | Shipped and tested | `test/steward-transfer.test.mjs` | A leader decides the transfer |
| Closeout reports | Shipped and tested | `test/closeout.test.mjs`, `test/corrections.test.mjs` | Template-based, no analysis. A readable page with a way to challenge or add context |
| Private opt-in mentoring | Shipped and tested | `test/sliceF6-mentoring.test.mjs` | Not wired to anything else, by design |
| Guided problem discovery | Shipped and tested | `test/vision-quest.test.mjs` | AI lane is a fixture unless an operator configures one |
| Metered model gateway and chat proxy | Shipped and tested | `test/gateway.test.mjs`, `test/proxy-chat.test.mjs` | Dollar caps, plus optional per-run call and token ceilings (`test/gateway-run-limits.test.mjs`) so a free model is bounded too |
| Static-page builder in a locked container | Built (fixture only) | `test/builder.test.mjs`, `test/container.test.mjs` | One-shot static HTML, verified against a local mock |
| OpenCode builder in the locked container, through the metered gateway | Built (live trial on a synthetic task) | `test/opencode-adapter.test.mjs`, `test/bundle-html.test.mjs`, `test/bundle-origin.test.mjs`, `scripts/opencode-container-trial.mjs` | One run: the agent wrote a three-file page, the host validated the bundle, and every model call was metered. Opt-in only. A finished bundle is shown to testers from a separate origin, where its script runs but cannot reach the app (`test/e2e/bundle-origin.e2e.mjs`). Without a configured bundle origin it falls back to a script-free page. Not a benchmark; one model, one task
| Continuous reanalysis (new internal results checked against earlier work; linked updates; new-decision path) | Shipped and tested | `test/reanalysis-verify.test.mjs`, `test/reanalysis-scenarios.test.mjs`, `test/reanalysis-delivery.test.mjs`, `test/reanalysis-open.test.mjs`, `test/reanalysis-schedule.test.mjs`, `test/e2e/reanalysis-journey.e2e.mjs` | Internal results only, deterministic matching (no model). Updates appear on frozen cases as linked annexes and in open SPEC threads as one labeled AI comment (at most one a week per thread). Run from the CLI, or on a timer with `serve --reanalysis-interval-minutes`
| Working ledger and sourced estimates | Shipped and tested | `test/ledger.test.mjs`, `test/estimate.test.mjs` | Estimates come from the gateway policy, prior builds and author judgment, labeled as such; they never set the approved cap. Statuses change only when the steward revises the SPEC |
| Private reflection after decisions | Shipped and tested | `test/reflection.test.mjs` | Notes stay in the person's browser only; they do not follow the person across devices |
| Departments and read scopes | Built (not verified live) | `test/read-scope.test.mjs` | Groups are admin-CLI managed; restricted work exposes existence and steward contact outside its audience |
| Opportunity propagation | Built (not verified live) | `test/propagation-s3.test.mjs` | Deterministic catalog/tag matching only; every edge remains a candidate until a person acts |
| Ask the organization (saved, re-runnable, contestable answers over what you may read) | Shipped and tested | `test/analysis-run.test.mjs` | Works without any model (sources only). A model lane exists but is off unless an operator enables it; no live model verified. Ranking or motive questions are answered with criteria, outcomes and unknowns, never a person ranking |
| Correctable derived memory | Shipped and tested | `test/corrections.test.mjs`, `test/knowledge-index.test.mjs` | Frozen packet copies, exports and backups can outlive an erasure; the live store tombstones dependent derived views and delivery |
| Teams channel adapter | Built (synthetic payloads only) | `test/channel-teams.test.mjs` | No real Teams, Graph, Entra, tenant install, SDK, or network |
| Other channels | Planned | none | Nothing shipped |
| Customer-owned storage, enterprise sign-in | Planned | none | Seams only |
| Scoring or ranking people | Not planned | none | |

Tests run on Node 22. See the [roadmap](ROADMAP.md) for order and the [decisions](DECISIONS.md) for why.
