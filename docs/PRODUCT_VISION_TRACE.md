# Product vision and implementation evidence

## Product direction and portable workflow

The working umbrella is **E.F.F.O.R.T. for Organizations**. **See / Spec / Send** remains its canonical improvement workflow. The related **E.F.F.O.R.T. for Organisms** name describes the personal product direction; this repository does not implement or merge that separate product.

Build the forum first as the complete product experience, including the full review and audit interface. Microsoft Teams / Microsoft 365 is the first external integration priority after that forum experience. Employees can then participate through their existing tools. Channel adapters must use the same authenticated workflow and immutable stage semantics. External messages and card clicks do not grant approval, change a frozen record or authorize spending. Capture must be deliberate and scoped, rather than automatic ingestion of workplace conversations.

Customer-controlled data, interchangeable models and bring-your-own coding harnesses are requirements. A customer knowledge store must preserve the authoritative event and transaction contract; it cannot replace the ledger merely by accepting documents. Harness compatibility must state which controls are independently enforced. Claude Code, Codex, OpenCode and custom CLI/agent connections remain integration targets, with a default to be selected through controlled evaluation.

Current limits: no Teams, Graph, Entra, Slack or SMS integration is shipped. SQLite remains the reference store. The adapter registry provides trusted application embedding for the static HTML profile, not a deployed external CLI connector, a sandbox or proof of model metering. No general coding default has been selected. No tenant installation, employer-data ingestion or production deployment is implied by this roadmap.

## Current implementation

The conversation is visible within this workspace. It is not an instruction to publish organizational or personal data on the public internet. Proposed audience identifiers do not create a per-item access partition: every enabled workspace member can currently read work posts.

| Requirement | Implementation | Evidence and limits |
| --- | --- | --- |
| Post a SEE in the person's own words; Vision Quest is skippable | `posted`, immutable original identity, OP revisions, separate Quest entry | Vision browser journey and rules-2 stories; no leader gate before SEND |
| Effort replies first and stays labeled AI | Durable first-reply job/status slot on SEE and first SPEC | Fixture browser proof; real provider requires operator configuration; failed/off status stays honest |
| People discuss, OP alone curates | Version-bound comments, Include/Paraphrase, author credits and diffs | Non-OP state/HTTP refusals and real browser inclusion |
| SPEC is a living post | Separate SPEC page, version history, assumptions, open questions, revisions and thread | Steward-requested structured draft from the full current SEE, edited and published by the steward; AI never publishes a spec as a person |
| SEND is the first independent approval gate | Frozen packet bound to one current SEE/spec, independent leader reason | OP/past-author refusal, single-use password step-up, visible decision history |
| Accountable dispositions | Rules 3 supports the nine agreed outcomes with reasons, exact reviewed packet and conditional fields | One immutable decision shown separately and referenced in BUILD; legacy generic NOs stay unclassified; no mandatory appeals or automatic reminders |
| Bounded build authority | Shared dollar cap across turns, iteration ceiling, fixed expiry | Worker and gateway independently reject stale or expired authority; model builder verified only with local mock |
| Collaboration and stewardship before a disagreement fork | A new `alternative` comment kind; `core/reconcile.js` projects each alternative as pending, incorporated, unresolved at freeze or unresolved after 14 days; `GET /api/items/:id/reconciliation`; the fork route refuses anyone without an unresolved alternative (the steward may still branch their own work) | The disagreer may fork when the stage moves on without including the alternative, 14 days pass, or the steward explicitly declines it (steward-only `decline` reply). No judging of reasons. A fork inherits no approval, so the leader still decides whether a second experimental build is worth funding. Derived from existing events; old forks and replay are untouched. Refusal tells the person when the window ends. Stewardship transfer on inactivity and an unavailable-author path are not built |
| Only adopted comments steer a builder | OP adoption, source credit, scoped instructions through container input | Real Docker/local mock proves raw discussion and identities stay outside the model request |
| Research states coverage and missingness | Six categories, off by default; optional internal workspace connector | No built-in external web search or vendor source; enabled queries give source identities and coverage |
| Human contributions remain attributable | Source-linked authored, included, adopted, credited and fork-source records | Derived rows verify/rebuild; no employee counts, rankings or motive claims |
| Related SEEs aid discovery | Literal workspace search and related-work links | No merging, blocking, deduplication decisions or implied independent corroboration |
| Mentoring is optional and private | Both opt in; invitation accepted by mentor; participant-only check-ins | No leader override; separate tables stay outside work search, decisions and event exports |
| Evidence sharing is consensual and revocable | PRIVATE default; mentor-only or one explicitly named recipient; owner revocation | Revocation stops future app access, not a copy already read; opting out revokes owned shares |
| Public demo is honest | Current rules-2 conversation panel with fixed fictional actors and fixture AI/builder | Real Chrome at phone width; earlier manual example remains labeled; no server/database/model in demo |
| Organizational questions preserve human objectives | Investigate screen prepares explicit work/time selection, objectives, constraints and exact source identities for the person's chosen AI | No model call or automatic reporting; private mentoring excluded; unknown coverage and selection bias stated |
| AI findings remain inspectable hypotheses | Answer review checks snapshot, criteria, citation membership, alternatives, uncertainty and missingness | Truth and citation support still require human review; English motive tripwire is limited; corrections go on attributed source discussion |

## Boundaries still requiring deliberate configuration or later work

The default worker and local preview use fixtures. A real container builder is available through the CLI with an operator-configured metering gateway; no hosted model vendor was called for these releases. External research, identity-provider sign-in and PostgreSQL are not shipped. Organizational investigation currently uses a human copying a reviewed packet into their chosen AI and pasting an answer back; built-in analysis and automatic briefs are not shipped. Frozen report bodies and artifact binaries are outside the analysis packet and require authorized human review. Organizational visibility tiers, retention policy, objectives and employment-related evidence rules remain owner decisions.

A frozen decision packet and independent copied records can retain text after its original source is erased. Backups also retain earlier copies. Target erasure is not claimed as a global purge.
