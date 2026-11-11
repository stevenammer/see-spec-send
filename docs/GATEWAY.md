# Local metering gateway

This slice provides a real `node:http` endpoint backed by SQLite and an injected
mock provider. It ships one deterministic local fixture. It makes no external
network request, uses no provider account or secret, and adds no runtime package.
It doesn't yet connect the fake worker to a model or run an external builder.

The gateway starts disabled. The CLI is its only administration surface:

```
node cli.js gateway fixture-enable
node cli.js gateway serve-fixture --port 8081
node cli.js gateway mint --run RUN_ID
node cli.js gateway status --item ITEM_ID
node cli.js gateway verify
node cli.js gateway revoke --digest SHA256_OF_CAPABILITY
```

All commands use `SSS_DB`, as the app and worker do. `serve-fixture` binds only
`127.0.0.1`. Enablement persists fixed fixture defaults: $1 lifetime, $0.10 per
UTC day, four concurrent reservations, 8192 input bytes, 1024 output tokens,
8192 response bytes and a two-second response wait. These are synthetic prices,
not a paid-spend authorization. An existing policy cannot be replaced through
these commands. A different programmatic policy is useful for local tests;
all processes sharing a database must use its persisted policy.

Mint requires an active, current SENDING run. Find its ID in the owner-only
SQLite `runs` table. The fake adapter normally finishes immediately; the seam is
intended for an injected waiting mock, or a later external adapter. Mint returns
a random credential once. Copy it directly to the caller's protected environment.
The database stores only its digest and the run, item, approval, spec and expiry.
It lasts fifteen minutes. Revocation takes its digest to avoid a secret in CLI
arguments. The worker's discarded old random tokens cannot be recovered. Mint a
new gateway credential when needed; don't pretend a restart recovers one.
Gateway capabilities aren't app sessions, person identities or generic API tokens.

Call `POST /v1/generate` with `Content-Type: application/json`, an
`Authorization` header containing the bearer scheme and minted credential, and
an `Idempotency-Key` of 1 to 128 letters, digits, colons, underscores or hyphens.
The entire JSON shape is:

```
{"model":"fixture:text-v1","input":"A synthetic prompt","max_output_tokens":10}
```

Unknown fields, model names and noninteger limits are refused. Only the named
fixture has a reviewed rate: one micro-dollar per input token and two per output
token, plus eight fixed input framing tokens. Input UTF-8 byte length is the
conservative token bound for this fixture protocol. A later real adapter must
review its own tokenizer, framing, hidden/reasoning tokens, price source and
maximum billable usage before it can use this control. No real model rate or
external provider adapter is supplied here.

Before forwarding, `BEGIN IMMEDIATE` validates the live capability and reserves
input byte bound plus framing and maximum output cost. Integer arithmetic must
remain nonnegative and safely representable. Admission checks the original
approval's cap, operator lifetime/day caps and concurrency. The reservation
stores the immutable payload hash, original approval body hash, cap, rate and
policy. No transaction waits on a promise or network operation. Immediately
before the provider function is called, a second short transaction checks live
permission again and durably marks dispatch. A confirmed refusal at that seam
can cancel the fresh reservation because no provider was invoked.

The original approval's legacy `charged` events and gateway receipts share its
run cap. A later legacy charge cannot cross an existing hold. Operator lifetime
and UTC-day caps cover gateway receipts, not other ways an operator might spend
money. Gateway access is not a financial cap on an external account.

A successful response includes the stored output and `estimated_micros`.
Settlement validates usage and computes exact integer micro-dollar estimates
from the frozen rate. Missing, negative, fractional, excessive or malformed
usage, output above its byte limit, exceptions and timeouts leave the full
worst-case hold. Unknown work also keeps a concurrency slot. A late valid result
can settle its original receipt after kill, expiry, respecification, new approval
or midnight. It never changes the newer approval's allowance or reservation day.

A retry of the same run/key/payload returns the stored result, or HTTP 202 with
an honest reserved/dispatched hold. It never calls the provider again. A changed
payload with the same key is refused. Both a crash before dispatch and a crash
after dispatch leave a hold on restart. There is no TTL refund, automatic
redispatch or manual release command. A request whose reservation was cancelled
at the fresh dispatch seam remains cancelled on retry. Use a new key only for
a new explicitly intended request. A lost client response isn't permission to
spend again.

Kill, stop intent, stale approval/spec, expiry and revocation block new dispatch.
A provider function already invoked can still complete and be accounted. There
is no distributed atomic transaction with an external provider or host watchdog.
A future adapter needs its own durable idempotency and reconciliation evidence.

`gateway status` and `gateway verify` validate receipt checksums, counts,
approval bindings and arithmetic before showing per-original-approval reserved,
unknown, settled and legacy amounts. Corruption refuses admission and status;
it never releases budget. These checks detect partial corruption, not a host
administrator who can rewrite the database and code. SQLite backup preserves the
ledger and capability digests; JSONL event export doesn't. Don't restore an old
backup into a running gateway. Stop it and set the independent kill latch first.

The app's read-only JSON API labels `context.spentMicros` and list `spent` as
legacy charged-event values and exposes a separate `gateway_budget` summary.
The pure state machine and helper quorum are unchanged. Gateway amounts are
price estimates, not invoices or third-party financial-cap certification.

Permanent tests cover real HTTP, a 100-request barrier one cent below a run cap,
two actual SQLite writer processes, duplicate requests, crash holds, late usage,
hostile limits/usage and capability isolation. The sandbox, egress enforcement,
artifact second origin, real provider, price review process, model drafting and
external financial enforcement remain separate work.
