# F9: preserve SPEC content, current AI context and remaining allowances

Including a SPEC comment now starts with the current requirements, success checks and exclusions. The new suggestion is appended to the requirements for the steward to review. Clicking Include no longer silently replaces earlier requirements with just that comment. Source credit and version binding remain intact.

Normal Effort replies now carry the current anchored SEE or SPEC and the exact triggering comment separately from the recent discussion window. Byte limits still apply. Explicit omitted-character and omitted-comment counts explain partial context, and the trigger survives a long thread even when it is outside the recent window. Structured first-SPEC drafting still uses its separate full-curated-text policy.

The SEE and SPEC screens show server-derived UTC-day allowances. Queued mention requests, on-demand model calls (including SPEC drafts), automatic first replies, and metered budget headroom are distinct. Charged holds remain in the budget. Queued work is not described as reserved, and remaining counts do not guarantee provider availability or an answer.

Provider, gateway and admin instructions now describe the commands that actually exist: temporary-password replacement/reset, reviewed policy versions, explicit hold reconciliation, container-backed workers, metered Quest/Effort and referenced artifact export. No real hosted-provider verification or paid-spend permission is implied.

## Verification

The four new regression scenarios passed, as did 32 related conversation, memory, draft and UI tests. The full real Chrome journey passed, including displayed remaining allowances after a mention, preserved SPEC requirements after Include, draft review, private mentoring, organizational packaging and hostile-answer/fake-citation refusal. Seven targeted mutations failed on intended behavioral assertions after correcting one non-unique mutation selector that initially hit the unrelated Quest helper. Full-suite and extended release gates remain pending.
