# Vendor security questionnaire

These answers describe the repository as it stands, not a hosted service commitment. See SECURITY.md, STATUS.md, and DEPLOY.md for operating detail.

| Topic | Answer |
| --- | --- |
| Access control | Local accounts and optional OpenID Connect authenticate people. Workflow authority is separate from sign-in. Department groups define item read scope. Real identity-provider testing is not yet done. |
| Encryption in transit | The service expects a TLS front end or direct TLS for non-loopback use. Plain HTTP is only allowed on loopback. TLS configuration and certificate operations are the deployer's responsibility. |
| Encryption at rest | Not provided by the application for the SQLite database. Use host or volume encryption. Backups can be encrypted when the operator supplies a key file. |
| Logging | Logs contain request ids, route templates, status codes, durations, and person ids where relevant. They don't contain request bodies, passwords, tokens, or model text. Person ids remain personal data. |
| Backup | Local backup, verification, restore, and pruning commands exist. Backups are not continuous replication. Recovery objectives depend on the operator's schedule and measured restore time. |
| Incident response | Kill latch, session/provider revocation, secret rotation guidance, erasure, verification, and doctor checks are documented in RUNBOOK.md. No staffed response-time commitment exists. |
| Subprocessors | None are required for the local core. Optional model providers receive selected record text if an operator enables them; their retention practices are not proven by this project. |
| Data location | The project writes to the deployer's SQLite database and backups. It doesn't provide a managed-region choice or data-residency guarantee. |
| AI model use | Optional and off by default. Model calls are metered and capped, with a non-model fallback. No claim is made that provider data retention is zero. |
| Vulnerability management | Tests, source scans, scoped mutation checks, and software adversarial reviews exist. Dependency monitoring, a formal vulnerability SLA, and a managed patch service are not yet provided. |
| Penetration testing | Not yet. Two software-based reviews found and fixed issues, but they are not an outside penetration test. An independent qualified assessment would change this answer. |
| SOC 2 | Not yet. There is no SOC 2 report or certification. A scoped program with controls, evidence collection, and an independent audit would change this answer. |
