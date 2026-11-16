# Steward transfer report

## Changed

- Added a pure active-stage inactivity projection in `core/reconcile.js`, using the existing 14-day reconciliation constant.
- `GET /api/items/:id/reconciliation` now includes `transfer`, with the inactivity state, eligibility date, and the signed-in person's request eligibility.
- Added `POST /api/items/:id/reconciliation/transfer-request`. It can only append a visible `transfer_request` comment for the caller's own `unresolved_after_window` alternative. It cannot change stewardship.
- Actual transfer remains the existing leader-only, reasoned `steward_changed` event. For rules 3, it now stops active work, clears active approval/spend state, and advances the approval fence so the successor needs a fresh Send and approval. Rules 1/2 replay retains its historical item-wide inactivity behavior.
- Synced `demo/lib/machine.js` from the core machine and documented the server-authoritative design in `docs/STAGE_POSTS.md`.

## Verification

- `node test/steward-transfer.test.mjs`: 5/5 passing.
- `node test/sliceR.test.mjs`: 10/10 passing.
- `node test/demo-parity.test.mjs`: 21/21 passing.
- `npm run check:demo`: passing.
- Final `npm test` was started once after the implementation. Before the sandbox's 30-second foreground limit, 11 test files passed and `test/gateway.test.mjs` failed because this environment refuses loopback listening (`listen EPERM: operation not permitted 127.0.0.1`). A direct gateway run showed 7/12 passing and the other 5 all failing on that same listener restriction. The required complete green full-suite result therefore could not be obtained in this sandbox.

## Open questions

None. The request-only endpoint leaves transfer authority with a leader as specified.
