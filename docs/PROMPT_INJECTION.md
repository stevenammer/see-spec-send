# Prompt injection and agent-abuse checks

The injection corpus is synthetic. It puts hostile text in posts, comments, ledger-like source notes, and names that look like files. The test uses a fake model that follows that hostile text whenever the surrounding product gives it a usable path.

`test/injection-harness.test.mjs` sends every corpus entry through the analysis, reanalysis verification, quest, SPEC-draft, Effort, and static-builder prompt paths. It checks that a model cannot create a decision, approval, or spend change; cannot return a restricted record outside the asker's read scope; and cannot introduce a made-up citation. Invalid analysis answers become the existing sources-only fallback. Model-originated text is labeled in each rendered or stored surface, and the page renderers use escaped text or DOM `textContent`; model-built HTML is separately allowlisted and rejects links, event handlers, scripts, and remote loads.

Contained by design:

- Authorization, workflow changes, approvals, caps, and ledger settlement happen in deterministic server code, not by parsing model prose.
- Analysis accepts citations only when they exactly match sources the requester can read. Reanalysis accepts only exact old-statement citations.
- Quest imports accept only the deterministic memo derived from the signed-in person's own transcript. SPEC drafts are review comments, not specifications or approvals.
- Effort comments are stored as AI comments and do not become an event type with authority. The builder receives only the approved lists and outputs static markup through a restrictive validator.

Limits:

- This does not prove that a provider will follow the system prompt, identify every language or encoding trick, or produce useful advice. It proves the product treats hostile provider output as untrusted at the authority, scope, citation, and rendering boundaries tested here.
- An authorized person may still choose to act on bad advice. The product labels model text and keeps human approvals separate, but it cannot replace human judgment.
- The harness uses synthetic data and in-process fakes. It does not test a live provider, a real identity provider, or every browser and assistive-technology rendering path.
