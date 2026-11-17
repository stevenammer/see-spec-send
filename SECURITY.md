# Security policy

## Report a vulnerability

Use GitHub's private reporting: **Security tab, then "Report a vulnerability"** on this repository. Please do not open a public issue or post details first. This is a one-person project, so there is no staffed response time; I read reports and fix real problems as quickly as I can, and I will credit you if you want that.

## Supported versions

Only the latest commit on `main`. There are no releases yet.

## What is here

The security work is written down, with its limits, so you can judge it instead of trusting it:

| Document | What it covers |
|---|---|
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, controls, what has and has not been tested, the two independent software reviews and what they found |
| [docs/SECURITY_WATCH.md](docs/SECURITY_WATCH.md) | Current public threats (Node.js, containers, coding-agent sandbox escapes, OAuth, OWASP lists) checked against this code, with open items |
| [docs/PROMPT_INJECTION.md](docs/PROMPT_INJECTION.md) | A 40-string hostile test set run through the six current model-facing paths |
| [docs/VENDOR_QUESTIONNAIRE.md](docs/VENDOR_QUESTIONNAIRE.md) | Honest answers to a standard enterprise security questionnaire |
| [docs/PRIVACY_DATA_MAP.md](docs/PRIVACY_DATA_MAP.md), [docs/RETENTION.md](docs/RETENTION.md), [docs/EMPLOYEE_NOTICE.md](docs/EMPLOYEE_NOTICE.md) | What is stored, retention and legal hold, and a plain-language notice for employees |
| [docs/AUDIT_LOG.md](docs/AUDIT_LOG.md), [docs/ROUTE_TABLE.md](docs/ROUTE_TABLE.md) | Audit export for a SIEM, and a generated list of every route with its authentication |
| [docs/DEPLOY.md](docs/DEPLOY.md), [docs/RUNBOOK.md](docs/RUNBOOK.md), [docs/HOSTING_DESIGN.md](docs/HOSTING_DESIGN.md) | Hardened container, backup and restore, incident steps, and the honest single-node limit |
| [docs/STATUS.md](docs/STATUS.md) | What is built, tested, and still not done |

## What this is not

It has had no outside penetration test, no SOC 2 audit, and no run against a real Entra, Okta or Google tenant. Two software-based security reviews and a certified-provider interop test are real work, and they are not substitutes for those. Treat anything handling real employee data as needing its own review.
