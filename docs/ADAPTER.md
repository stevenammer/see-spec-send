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

## Slice 11 container adapter

`worker/container.js` is the real builder adapter. It accepts only the existing
stable worker request and persists that exact request in `container_jobs` before
it creates a directory, mints a capability, or asks Docker to do anything.
The same ID with changed input is refused. A stop tombstone fences a later start.
A new adapter instance reads the durable row, checks the named container, and
either finds the one output file or reports its terminal state.

The pinned image is recorded in `worker/builder-image.digest`. Startup refuses a
tag without a SHA-256 digest. The adapter runs as UID 65532 with `--network none`,
a read-only root filesystem, all capabilities dropped, no new privileges, a 32 PID
limit, 0.50 CPU, 64 MiB memory and swap limits, and a 16 MiB `noexec` tmpfs at
`/tmp`. The approved spec is a read-only file, the builder source is read-only,
and `/out` is the only writable mount. A durable deadline makes `status` kill a
run that passed its wall-clock limit. `stop` records intent, revokes the capability,
kills the named container, removes it, and remains stopped when called again.

The sole model-text path is a Unix-domain socket bind-mounted as
`/gateway/gateway.sock`. There is no Docker network namespace, DNS, or general
egress. The socket goes to the local metering gateway only. The adapter mints a
fresh capability against the active run, so it is already bound to that run, item,
approval and spec by the gateway ledger. The raw value is passed only as the
builder's process environment. The database stores its digest. Completion and
stop revoke the digest.

The gateway owner must make that one socket connectable by UID 65532, or by a
group that UID belongs to. The adapter doesn't loosen a gateway socket's host
permissions. It creates the approved-spec file as world-readable and the output
directory as write-only for other host users so that the non-root builder can use
its two mounts without gaining access to anything else.

`worker/builder/index.js` reads exactly the approved three lists, sends them to
the fixture gateway, and writes one `try.html`. It rejects oversized HTML,
external or protocol-relative URLs, event handlers, and every script tag. It
doesn't receive comments, a person credential, an item session, or permission to
write the item. The worker alone delivers the resulting bytes as `tried`.

`npm test` covers the adapter's durable identity, fake-Docker command construction,
deadline fencing, stop, output validation and worker delivery without Docker or a
network. `npm run test:container` is deliberately separate because this sandbox
cannot reach Docker. It starts local Docker containers and a local mock gateway.
It checks the inspected hardening settings, probes network and filesystem escape
attempts, exercises PID and memory pressure, tests wall-clock termination and
stop, and completes a worker delivery. It does not prove host-kernel isolation,
Docker daemon security, seccomp/AppArmor policy, a malicious base image, or a real
model provider. It makes no external request or model call.

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
