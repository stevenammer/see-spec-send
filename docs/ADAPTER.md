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
approval and spec by the gateway ledger. The raw value is passed as the builder's
process environment, which also places it on the `docker run` argument vector and
in Docker inspection metadata. The database stores its digest. Completion and stop
revoke the digest.

The gateway owner must make that one socket connectable by UID 65532, or by a
group that UID belongs to. The adapter doesn't loosen a gateway socket's host
permissions. It creates the approved-spec file as world-readable and the output
directory as write-only for other host users so that the non-root builder can use
its two mounts without gaining access to anything else.

`worker/builder/index.js` reads exactly the approved three lists, sends them to
the fixture gateway, and writes one `try.html`. Its filter first runs the old regex
(oversized HTML, external or protocol-relative URLs, event handlers, script tags),
then parses every tag against an element and attribute allowlist. It refuses
backslashes anywhere, character references and colons in attribute values, and
any `url(` or `@import` in style. Entity-encoded `srcdoc` and `href` values fail
that allowlist. The container reads the output with no-follow, a regular-file
check, and a size check before any read, from a sticky output directory. A
model-built try is framed with no script permission. The builder doesn't receive
comments, a person credential, an item session, or permission to write the item.
The worker alone delivers the resulting bytes as `tried`.

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

## Versioned organization adapter seam

The executable contract in `worker/adapter-contract.js` offers version 1 of a
**static HTML profile**, with `static_html`, `approved_spec`, and optional
`adopted_instructions` capabilities. Selection refuses unknown versions,
capabilities, and profile names before constructing an adapter. The existing
worker CLI uses the built-in `fixture` and `container` profiles. The fixture is
the existing default for local demonstrations, not a claim that it is the best
builder. No general-purpose default has been selected or benchmarked.

A trusted application integrator can register a name and versioned capability
manifest with `createBuilderRegistry()`, providing a factory for a synchronous
transport implementing `start(request)`, `status(id)`, and `stop(id)`. Selection
wraps the transport in `createBridgeAdapter`. It checks run identity and input
shape, removes instruction author/source metadata, freezes the approved request,
and validates status shape and ready HTML. The worker still independently checks approval and controls its run lifecycle,
stop requests, and delivery. Registered in-process code has host privileges and
can bypass these checks or call providers directly; this wrapper does not confine
it, enforce its spending, or prove that a stop request terminated its work. The bridge may hand the
request to a separately managed CLI or agent, but **the transport and that
execution environment must be deployed and reviewed by the organization**.
This registry is trusted host configuration, not a browser API, dynamic module
loader, command runner, network endpoint, or installer.

The bridge must durably bind each ID to one immutable request, recover status
after restart, fence stop-before-start and late completion, and return promptly. `test/helpers/builder-bridge-conformance.mjs` provides a
reusable baseline against a persistent synthetic transport; it cannot establish
security or accounting guarantees.
The organization must enforce the approved spec and scope, time and aggregate
budget, sandbox and all model-call metering independently of the agent. Declared
capabilities are compatibility claims, not proof or permission grants; the
static HTML validator does not sandbox agent execution. The existing gateway is
a narrow completion protocol, not a general tool-calling agent proxy. A separate
integration must demonstrate that every model call passes the authorized budget
and that the agent cannot bypass the sandbox or access unapproved tools. No
Claude Code, Codex, OpenCode, or other general agent bridge is implemented here.
They are potential integration targets, not supported profiles or benchmarked
winners. Multi-file/code artifacts, shell tools, and network capabilities are
not supported by version 1. A richer profile requires a separately reviewed
contract and external enforcement.


## Proposed next slice, not implemented

A future offline prototype can connect a fixed, operator-configured fixture
process through private local IPC. The trusted controller would derive and
journal an immutable run envelope from the existing approval, spec, packet,
scope, policy and deadline, bind each run ID to its request digest, and retain
stop tombstones across restarts. The protocol would use bounded versioned
`start`, `status` and `stop` messages. It would accept no browser-supplied
command, network endpoint, model key or package installation.

A deterministic fixture could return a synthetic multi-file source bundle with
a manifest of relative paths, byte counts and digests. Before storage, trusted
code would independently recompute hashes and enforce file-count and byte
limits, reject path traversal, duplicate paths, symlinks and unexpected
executables, and recheck current authorization. The review surface would show
the validated manifest; the existing static HTML artifact and preview would
remain unchanged. An isolated interactive preview, real harness execution,
tool-capable model proxy, comprehensive per-call accounting and any new
permissions require separate design and verification.

Acceptance would include duplicate and changed-payload starts, stop before
start, crash and reconnect, malformed and oversized messages, unsafe paths and
links, file changes during validation, stale approval and late completion. An
IPC protocol alone is not isolation or proof that a process stopped. This is a
proposal, not an implemented bridge or support for any named coding harness.
