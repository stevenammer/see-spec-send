# Builder contract

I've kept the builder behind `start(request)`, `status(id)`, and `stop(id)`.
`test/worker.test.mjs` exports `adapterConformance` and runs it against the fake.
The integration tests cover the authority boundary around that contract.

`start` accepts a stable run ID, item ID, approval number, approved spec hash,
cap in integer micro-dollars, and only the approved spec's three lists. It gets no
comments, person credentials, or authority to change the item. Repeating the same
request resumes one logical run. Reusing its ID with different input is an error.
A fresh adapter instance must recover the same output. The fake's output is a tiny
static HTML page, deterministic for that spec hash. It uses no network or model.

`status` returns `missing`, `running`, `ready` with HTML, `failed`, or `stopped`.
`stop` is repeatable and returns an observed status. It must fence later starts of
that ID, even when stop arrives first. The worker retries until `failed` or `stopped`.
There's no separate steer operation. A new spec stops the previous run.

The worker registers separate item-scoped run and gateway token identities, with
only digests in the registry. The fake returns bytes to the worker, which appends
`tried` under the run identity with the frozen approval and spec hash. It doesn't
post charges. A separate local metering gateway now exists; see GATEWAY.md. Its
CLI mint binds a fresh credential to an active run. The discarded worker secret
isn't recovered or transported to the fake adapter.

Calls are synchronous and short. I hold a database write lock while validating and
submitting a start. An external adapter must enqueue an independently durable,
idempotent request and return promptly. It must never wait for a build under that
lock. A lost response can cause another `start` call with the same ID. A transaction
alone can't promise exactly one external side effect. That adapter must prove it.
The fake persists its request in the same database transaction.

The worker stores HTML and its `tried` event in one transaction. It rejects stopped
or superseded runs before storing bytes. A duplicate delivery returns false without
storing anything. Adapters never get a person identity, so they can't approve,
change steward, vote, or move an item to Helps.

## Slice 7 adapter policy, offline proof only

An external adapter receives the stable request above plus an explicit policy.
The fixed default denies all egress, exposes only approved-spec read and artifact
write scopes, and requires CPU, memory, and wall-clock limits. The offline fake
sandbox refuses synthetic host-mount, cross-run-read, raw-socket, egress, memory,
and time escape attempts, then fires its emergency-kill callback.

This does **not** prove a container, user namespaces, read-only mounts,
seccomp/AppArmor, DNS/rebinding protection, redirect/IP validation, real network
interception, or process termination on a host. No OpenHands or Docker image was
used. A real-container acceptance test remains required before an external builder
is trusted.
