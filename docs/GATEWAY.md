# Local metering gateway

The gateway provides a real `node:http` endpoint backed by SQLite. Its deterministic
fixture makes no external request and uses no provider account. An explicitly
configured provider can make model calls; those calls require reviewed prices and
operator authorization. No runtime package is required.
`gateway serve --socket PATH` exposes it to the container builder over a Unix socket (see ADMIN.md). Use `--fixture` for the Unix-socket fixture; use `--name NAME` for an explicitly configured provider. The default worker uses its fake adapter until a container builder is selected.

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
not a paid-spend authorization. The initialization command does not replace an existing policy. Use
`gateway policy set --file policy.json` to record a reviewed replacement policy
version; all processes sharing a database use the persisted policy.

Mint requires an active, current SENDING run. Find its ID in the owner-only
SQLite `runs` table. The fake adapter normally finishes immediately; the seam is
usable for an active container-builder run as well as an injected waiting mock. Mint returns
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

Unknown fields, model names and noninteger limits are refused. The local fixture has a synthetic rate of one micro-dollar per input token and two per output
token, plus eight fixed input framing tokens. Input UTF-8 byte length is the
conservative token bound for this fixture protocol. A later real adapter must
review its own tokenizer, framing, hidden/reasoning tokens, price source and
maximum billable usage before it can use this control. Configured providers supply an explicit reviewed model and integer price table.
The app cannot verify the provider's invoice or an operator's pricing assumption.

## Chat-completions proxy

The fixture gateway also exposes `POST /v1/chat/completions`, using the same
Bearer run capability and `Idempotency-Key`. It accepts an OpenAI-shaped request
with `model`, nonempty `messages`, optional `tools`/`tool_choice` or legacy
`functions`/`function_call`, required integer `max_tokens`, and required boolean `stream`. Tool calls are returned
unchanged in `choices[].message.tool_calls`; streaming returns SSE
`chat.completion.chunk` records and a final `[DONE]`. This is the metered route
for a multi-call agent: every individual completion has its own idempotency key
and receipt.

Before either a normal or streaming upstream chat dispatch, the gateway reserves
the serialized request byte bound plus framing and `max_tokens` at the reviewed
rate. It checks the capability again immediately before dispatch and before each
streamed upstream chunk. Stop, kill, stale approval/spec, expiry, revocation, or
cap exhaustion refuse the following request. A changed condition during a stream aborts
the upstream signal and ends SSE with a generic gateway error and `[DONE]`.
Reported final usage settles the hold. Missing or malformed usage leaves the
worst-case hold, including its concurrency slot. The durable receipt retains the
call ID, run ID, model/rate snapshot, token usage, charge, state, and hashes.
It intentionally stores neither prompts nor normal or streamed response bodies.
Consequently, a completed chat request cannot be replayed after a client loss:
the same key reports its settled receipt as `202`, and never sends the upstream
request again.

The shipped fixture returns a synthetic function call and synthetic usage, does
no network I/O, and has no provider account. The existing OpenAI-compatible
provider adapter also implements this transport, including bounded SSE parsing,
when an operator has separately configured and approved it. Other provider
adapters remain text-only and this route refuses them rather than falling back
to an unmetered call.

Before forwarding, `BEGIN IMMEDIATE` validates the live capability and reserves
input byte bound plus framing and maximum output cost. The real builder, Effort,
and Quest paths add a UTF-8 byte bound for their server-owned system text to
the separately reviewed framing allowance. Effort reserves for the larger of
its two possible system texts. Fixture paths without system text are unchanged.
This does not establish a universal provider billing bound: the operator must
still review provider-specific framing, tokenizer and other billable overhead. Integer arithmetic must
remain nonnegative and safely representable. Admission checks the original
approval's cap, operator lifetime/day caps and concurrency. The reservation
stores the immutable payload hash, original approval body hash, cap, rate and
policy. No transaction waits on a promise or network operation. Immediately
before the provider function is called, a second short transaction checks live
permission again and durably marks dispatch. A confirmed refusal at that seam
can cancel the fresh reservation because no provider was invoked.

The original approval's legacy `charged` events and gateway receipts share its
shared approval cap across all its iterations. A later legacy charge cannot cross an existing hold. Operator lifetime
and UTC-day caps cover build, Quest and Effort receipts together, including charged
holds. They do not cover other ways an operator might spend money. Gateway access is not a financial cap on an external account.

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
after dispatch leave a hold on restart. There is no TTL refund or automatic
redispatch. An operator can inspect `gateway holds list` and explicitly reconcile a
hold with `gateway holds release --id ID --reason REASON`, optionally `--refund`
only when the evidence supports it; this records an audit receipt. A request whose reservation was cancelled
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

### Enforcement boundary

Enforced: calls sent through this gateway with its minted per-run capability are
reserved before dispatch, charged or held in the shared approval cap, isolated to
that active run, and stopped at the next admission or stream-chunk check after a
live permission change. Receipts contain no chat body.

Not enforced: a BYO agent that uses its own provider key or another endpoint can
bypass this gateway and its cap. The gateway does not control an external
provider account, certify provider token counts or invoices, undo provider work
already dispatched, or terminate an agent process that ignores an aborted stream.

Permanent tests cover real HTTP, a 100-request barrier one cent below a run cap,
two actual SQLite writer processes, duplicate requests, crash holds, late usage,
hostile limits/usage and capability isolation. The sandbox, egress enforcement,
artifact second origin, real provider, price review process, model drafting and
external financial enforcement remain separate work.
