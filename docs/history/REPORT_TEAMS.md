# Teams channel adapter report

Built a synthetic-only channel contract in `channels/adapter.js` and a Teams-shaped fake activity mapper in `channels/teams.js`.

The adapter records preview, confirmation, contribution, signed-action, source-change, and delivery receipts. It uses admin-created tenant-scoped identity mappings, durable callback IDs, a five-minute HMAC timestamp window, and durable nonce receipts. Canonical writes use `Store.append`, so leader authority, packet hash binding, post freshness, freezes, and native idempotency remain authoritative.

Added migration 21 for channel teams, identity mappings, external receipts, and nonces. `channel map add` creates an explicit mapping and activates the selected synthetic team. Disconnect and access revocation disable capture and delivery.

`test/channel-teams.test.mjs` covers deliberate capture/confirmation, forged identity, tenant mismatch, guests, nonce replay, duplicate callback, non-leader approval, wrong packet, stale card, late replies, source edits, restricted audiences, disconnect, and native/Teams parity.

Not built: real Teams, Graph, Entra, Bot Framework JWT validation, SDK use, tenant installation, network listener, credentials, or tenant traffic. The HMAC transport is a deterministic test seam only.

Verification completed: `node --test test/channel-teams.test.mjs test/slice21.test.mjs test/read-scope.test.mjs test/stage-freeze.test.mjs`, `node scripts/check-public.mjs`, and `git diff --check` passed. `npm test` could not complete in this sandbox: `test/gateway.test.mjs` has five listener cases that fail before exercising their assertions because loopback bind returns `listen EPERM: operation not permitted 127.0.0.1`. Those cases are: `gateway HTTP settles exact integer micros and persists only credential digests`, `100 barrier HTTP calls one cent below cap never forward refused reservations`, `concurrent duplicates get one outcome or honest unresolved hold without redispatch`, `server validates hostile limits, model prices, payload keys, capability scope and expiry`, and `CLI status and API budget expose original approval holds separately from legacy events`. The test runner stopped there, so no full-suite pass is claimed.
