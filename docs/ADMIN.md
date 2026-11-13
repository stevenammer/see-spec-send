# Admin commands

Set `SSS_DB` to the database path. The CLI is the only administrator surface.

`node cli.js init --id leader` creates the first leader and prints that leader's
initial password. Save it before closing the terminal. It is never stored as
plaintext, but it remains valid because no password-change or reset command exists.

`node cli.js invite create --role member --expires 24h` prints one redeemable invite.
Roles are `member` or `leader`.

`node cli.js person list` prints registered people and leader flags.

`node cli.js integration source add --name NAME --secret SECRET` creates an inbound
source. `integration destination add --name NAME --url HTTPS_URL --secret SECRET`
creates an outbound receiver. Add `--include-text` only when that receiver may
receive item text. `integration outbox list` shows pending, delivered, and dead
letters. `integration outbox deliver` attempts ready rows. See [INTEGRATIONS.md](INTEGRATIONS.md).

`node cli.js session revoke --person ID` removes every session for that person.

`node cli.js token create --kind gateway --item ID` and `--kind run` print an item-scoped
token once. Only its digest is stored.

`node cli.js verify` verifies each item's hash chain. `node cli.js export` prints JSONL.
`node cli.js backup --to FILE` checkpoints SQLite then copies its database file.
`node cli.js restore --from FILE` restores into a database path that doesn't already exist.

Import trusts the actor registry inside the JSONL before replaying events. Import is an
administrator action. Run it only on an export you made yourself.

`node cli.js serve --port 8080 --origin http://127.0.0.1:8080 --insecure-cookies` starts the web server.
Secure cookies are the default. `--insecure-cookies` is only for local HTTP development on loopback, and the
command prints a warning when it is used. For HTTPS, omit it and give the public HTTPS origin. A non-loopback
`--host` needs `--tls-cert` and `--tls-key` (direct HTTPS) or `--trusted-proxy` (one loopback TLS front end).
`serve` refuses to start otherwise. SIGTERM closes the listener and then the database.

Old-format authority is captured once from the registry during migration. Its original
hashes are preserved, so those historical roles cannot be independently authenticated
from the old chain. Migration rebuilds the derived context cache in the same transaction.
Later registry edits and reopening do not recapture those roles.

The store has erasure receipts that bind replacement tombstone bytes, but no CLI
command invokes erasure. Erasure is not an operator feature yet. If it is invoked by
code, unknown body metadata is removed along with authored text; actor IDs and
structural references remain. It does not guarantee removal from backups or earlier
copies of the database.

## Worker and emergency stop

I run the fake builder in a separate terminal with `node cli.js worker` using the
same `SSS_DB` as the server. It reconciles every 250 milliseconds. `node cli.js worker --once`
runs one pass and exits. Another pass may be needed to observe the adapter's stop.
By default the adapter is the fake. It makes a tiny static try without a model or a charge.

### Model-built tries with the container builder

Two long-running processes and one Docker image. All use the same `SSS_DB`.

```
node cli.js provider add --file provider.json        # your provider; the key stays in an env var or key file
node cli.js gateway fixture-enable                   # sets the fixed default caps (see GATEWAY.md)
node cli.js gateway serve --socket /srv/sss/run/gateway.sock --name yourprovider
node cli.js worker --builder container --gateway-socket /srv/sss/run/gateway.sock
```

`gateway serve` keeps the provider key; the builder container never sees it. The socket's directory must be private to the service user (the command refuses a directory others can write). The container gets a one-run token that the gateway checks against the approved spec and the caps. The token reaches `docker run` through its environment, not its arguments, so it isn't in the host process list. It is still visible to anyone who can run `docker inspect`, which means anyone with Docker access.

**The worker needs the Docker socket, and that is root on the host.** Run the worker as a dedicated user on a host that holds nothing else you care about, or accept that anyone who can make the worker misbehave can take the host. The container itself has no network, a read-only root, a non-root user, no capabilities, and limits on processes, CPU and memory. Every `docker` call the worker makes has a 20 second timeout. The build deadline (30 seconds) is also enforced inside the container, so a dead worker cannot leave a build running. `kill set` and the watchdog stop named builder containers.

Pinned image: `worker/builder-image.digest`; its package list is `worker/builder-image.sbom.txt`. Pull it first: `docker pull $(cat worker/builder-image.digest)`.

`node cli.js kill set` sets an independent `SSS_DB.kill` file before recording the
stop in SQLite. It blocks new starts, charges, and try delivery. Existing runs get
persistent stop requests. A running worker tells the adapter to stop on its next pass
and retries until it observes a terminal status. If the worker isn't running, I have
to start it to finish those stop requests. This isn't a host-level process watchdog.

`node cli.js watchdog` is the host-level companion. It fails closed when a worker
heartbeat is stale, a run is beyond its wall-clock cap, or an old dead or sending
outbox entry is found. It calls the same kill latch and records `watchdog.stop`.
Install the unit in `docs/systemd/` or use Compose. See [QUICKSTART_ORG.md](QUICKSTART_ORG.md).

`node cli.js kill status` prints `stopped` or `clear`.
`node cli.js kill clear` explicitly clears the latch. It never revives a stopped run.
An interrupted current run gets a `failed` receipt when the worker observes its stop,
so a leader can approve again. Set and clear also leave rows in `worker_history`.
Those global receipts aren't part of an item's hash chain.

I keep the database and its adjacent kill file together, with one canonical path.
Don't use different symlink paths to the same database. A latch read error blocks
work. A failed clear can leave the file set; check status after fixing the error.
The database backup includes worker rows, but not the separate latch file. JSONL
export doesn't include worker state or artifact bytes, so it isn't a worker backup.
Don't restore an old database into a running worker. Stop it and set kill first.

Database symlinks resolve to the real database path before selecting the independent
kill file, so opening the same database through a symbolic link observes the same
stop latch. The SQLite backup still does not include that file.


## Local fixture gateway

See [GATEWAY.md](GATEWAY.md) for the disabled-by-default listener, explicit fixture
policy, scoped capability mint/revoke seam, durable estimates and unknown holds.
`node cli.js gateway status` and `gateway verify` check the ledger before showing
amounts. The gateway CLI never configures or calls a real provider. SQLite backups
include gateway rows; JSONL exports don't. The existing `token create` command
creates a generic item token, not a usable metering capability.
