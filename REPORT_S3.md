# S3 report

Implemented the S3 data and deterministic propagation foundation without changing `core/machine.js`.

## Delivered

- Schema 17: admin-managed `groups` and `group_members`, plus a capability catalog.
- `node cli.js group create|add|remove|list` management commands.
- Rules-3 `posted.audience` and `posted.related` validation in `Store.ensureEvent`. Audience is creation-only, so it cannot be widened through later item events.
- Real scope records and `canRead` enforcement on item pages, item listing, record pages, artifact delivery, closeouts, updates, digest delivery, workspace search, evidence packages, and reanalysis matching/delivery.
- Restricted item page wording exposes only existence and its steward contact.
- New append-only knowledge kinds: `edge` and `capability`.
- Deterministic capability catalog, candidate propagation, fixed edge-case question checklist, and dismissed-edge suppression.
- Added `test/read-scope.test.mjs` and `test/propagation-s3.test.mjs`.

## Verification

Passed:

```text
node --test test/read-scope.test.mjs test/propagation-s3.test.mjs test/reanalysis-core.test.mjs
```

`git diff --check` passed.

The complete `npm test` run did **not** pass. It stopped at `test/gateway.test.mjs`, whose first test opens a real `127.0.0.1` listener. This sandbox blocks loopback listeners (`EPERM` in this environment), so I could not run that test, `test/listener.smoke.mjs`, or claim the full suite passed. No production listener was started.

No commit or push was made.
