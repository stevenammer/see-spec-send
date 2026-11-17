# Security

## Reporting a problem

Open a private security advisory on the project's GitHub repository, or contact the maintainer listed there. Please do not post details publicly first. There is no bug bounty and no response-time promise; this is a small open-source project.

## Supported versions

Only the latest commit on `main`. There are no releases yet.

## What has and has not been tested

- Every claim in [STATUS.md](STATUS.md) names the test that covers it.
- An independent adversarial review (a second reader written to attack, working from the code) found three real read-scope leaks on 2026-11-16. All three were fixed and now have regression tests and mutation checks. A second independent review of the newer surfaces (sign-in, operations, import and export, backups, erasure) found five more: password invitations still worked in single-sign-on-only mode, a forged export could carry leader authority, metric labels could grow without bound, and erased text survived in stored decision packets and old closing reports. All five are fixed with regression tests, and the same pass found and fixed the erased wording surviving in saved question answers, the ledger table and source copies. Both reviews were done by software, not by an outside security firm, and are not a substitute for one.
- A scoped mutation check breaks about forty security-relevant rules one at a time and confirms the tests catch each.
- Load, crash and restore drills run (`scripts/drill.sh`, `scripts/load.mjs`).
- **Not done:** an outside penetration test, a formal threat-model review with the people who would use it, fuzzing, and any real identity-provider or Teams integration.

## Threat summary

See [THREAT_MODEL.md](THREAT_MODEL.md) for the full model. In short:

- Authentication proves who someone is. It never grants workflow authority; the state machine does, and an AI or a card click cannot approve.
- Frozen records cannot be changed. Later information is a separate, linked update.
- Restricted work shows other people only that it exists and who to ask, and content may only flow to people who can read its source.
- Model-built code runs on a separate origin under a strict content policy that blocks network requests, and its spend is metered and capped.
- Secrets are never stored in files, logs or URLs.

## Where data can go

| Place | What goes there | What is and is not proven |
| --- | --- | --- |
| The SQLite database | Everything: events, accounts, derived records | Owner-only file permissions are checked by `doctor`. Not encrypted at rest by this project; use disk encryption. |
| Backups | A full copy | Tamper-checked on restore. Encrypted only if you pass a key file. |
| Logs | Request ids, route templates, status codes, person ids | No bodies, passwords, tokens or model text. Person ids are personal data. |
| Model providers (optional, off by default) | The text of the records an operator chooses to send, and prompts | Metered and capped. Whether a provider keeps data is the provider's policy, not proven here. Use synthetic or approved data only. |
| The metered gateway receipts | Model, token counts, cost, hashes | No prompt or response bodies are kept. |
| The bundle origin | A build's files, served to testers | Isolated from the app by origin; a build's script can still draw on screen and navigate its own frame. Text a tester types into it is not private from it. |
| Derived indexes and knowledge records | Quotes from records, with sources | Removed or tombstoned when a source is erased; frozen packet copies and backups can outlive an erasure. |
| External channels | Not built. The synthetic adapter makes no network calls. | Nothing real is connected. |

## Secrets

Provider credentials come from the service environment at call time and are never read from a file in the repository. The bundle-origin signing secret is random per process. The OIDC client secret (when sign-in is configured) is named by environment variable, never written in the config. `check:public` scans the tree and history for credentials and private paths before anything is pushed.
