# Admin commands

Set `SSS_DB` to the database path. The CLI is the only administrator surface.

`node cli.js init --id leader` creates the first leader and prints that leader's
temporary password. Save it before closing the terminal. It is never stored as
plaintext. Sign in and change it before working. `person reset --id ID` prints a
one-time reset code; a temporary credential does not grant normal app access.

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

### Playable OpenCode bundles

Use `serve --bundle-port 8081` to enable script-capable, model-built bundle tries on a separate origin. `--bundle-host-suffix` defaults to `localhost`, so browsers resolve signed per-bundle labels to loopback. The bundle listener has a random, process-local signing secret and never logs it. It serves only GET and HEAD for files listed in a validated manifest.

This origin protects the app's cookies, API, and local storage from model-built code. It does not make that code safe to trust: it can render or navigate inside its own frame, and anything a tester types into the build is visible to it. Do not enter sensitive data.

Old-format authority is captured once from the registry during migration. Its original
hashes are preserved, so those historical roles cannot be independently authenticated
from the old chain. Migration rebuilds the derived context cache in the same transaction.
Later registry edits and reopening do not recapture those roles.

The store has erasure receipts that bind replacement tombstone bytes. The signed-in
product erasure route checks author/steward/leader authority; erasing someone else's
text requires a stated privacy/legal ground and an attributable note. Decisions and
original SEE records are protected. There is no separate erasure CLI. Unknown body
metadata is removed along with authored text; actor IDs and structural references remain. It does not guarantee removal from backups or earlier
copies of the database.

## Worker and emergency stop

I run the fake builder in a separate terminal with `node cli.js worker` using the
same `SSS_DB` as the server. It reconciles every 250 milliseconds. `node cli.js worker --once`
runs one pass and exits. Another pass may be needed to observe the adapter's stop.
By default the adapter is the fake. It makes a tiny static try without a model or a charge.

### Model-built tries with the container builder

Two long-running processes and one Docker image. All use the same `SSS_DB`.

```
node cli.js provider add --file provider.json
node cli.js gateway fixture-enable
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
work. The database backup includes worker rows, but not the separate latch file. JSONL
export includes referenced SEND/TRY artifacts but not live worker/gateway state or private mentoring, so it isn't a full database backup.
Don't restore an old database into a running worker. Stop it and set kill first.

## Local fixture gateway

See [GATEWAY.md](GATEWAY.md) for the disabled-by-default listener, explicit fixture
policy, scoped capability mint/revoke seam, durable estimates and unknown holds.
`node cli.js gateway status` and `gateway verify` check the ledger before showing
amounts. The gateway CLI never configures or calls a real provider. SQLite backups
include gateway rows; JSONL exports don't. The existing `token create` command
creates a generic item token, not a usable metering capability.

## Workspace research and search (F5)

Node 22.19 or newer with SQLite FTS5 is required. Search and contribution records are derived, verified workspace indexes. Every enabled member can currently read the workspace; there is no per-item audience partition. Resource/audience proposal IDs do not grant access.

Internal prior-work research starts off. `node cli.js research status` reports it. An operator can use `node cli.js research enable --source this_workspace` or `disable` to change it; changes enter the admin audit. It performs no network or model call. External sources remain disconnected. Refreshing a SPEC research record states what was checked, gives source identities, and preserves the snapshot used at SEND.

Erasure removes the target from the active search index and leaves a contribution tombstone. It does not purge text already copied into another record, a frozen packet, or a previous backup. Contribution pages show records, never employee rankings or performance scores.

# Reanalysis

`node cli.js reanalysis run [--limit N]` processes synthetic recorded knowledge against frozen posts and records linked annexes plus in-app digest entries. It does not schedule work, send an outbound message, approve anything, spend money, or start a build.

## Reanalysis on a timer

`node cli.js serve --reanalysis-interval-minutes N` (5 to 1440) runs a reanalysis pass inside the server every N minutes. It is off unless you pass the flag. A lock file next to the database (`sss.db.reanalysis.lock`) keeps a second server on the same database from running a second scheduler; a lock left by a crashed server is cleared. A slow pass is never overlapped, and a failed pass is logged and tried again on the next tick. You can still run one pass by hand with `node cli.js reanalysis run`.

## Checking a model lane

`node scripts/eval-model-lanes.mjs` runs a small labeled evaluation of the two optional model lanes against a configured Bedrock model (AWS credentials come from the environment; `EVAL_MODEL_ID` selects the model). It prints agreement with the labels, how often the reply was valid and grounded, whether prohibited questions are refused before any model call, and the approximate cost. A run costs a few cents at most. It is a sanity check on a small synthetic set. Re-run it after changing a prompt or switching models.

## Single sign-on (OpenID Connect)

`node cli.js serve --oidc-config FILE` turns on sign-in through any standards-compliant identity provider. Authentication only proves who someone is: workflow authority still comes from the state machine, and a leader is never made from a claim in a token.

```json
{
  "issuer": "https://idp.example.org",
  "clientId": "your-client-id",
  "clientSecretEnv": "SSS_OIDC_CLIENT_SECRET",
  "redirectUri": "https://sss.example.org/api/oidc/callback",
  "hosts": ["idp.example.org", "sss.example.org"],
  "allowedEmailDomains": ["example.org"],
  "autoProvision": false
}
```

- The client secret is read from the environment variable named in `clientSecretEnv`. It is never written in the file.
- **Microsoft Entra:** pin the tenant with `tenantId` rather than relying on `allowedEmailDomains`. Entra ID tokens usually carry no verified-email claim, and a domain rule with no email is refused on purpose. Entra publishes signing keys without an `alg` field; that is supported, and the key type must fit the token's algorithm. For other providers, `allowedEmailDomains` needs the provider to put a verified `email` in the ID token itself (some providers keep it in the userinfo response by default; change that setting).
- Tested against a certified independent implementation (node-oidc-provider) in a real browser: sign-in, PKCE, nonce, RS256 signature check, the `iss` callback parameter, and step-up with `prompt=login`. Run `OIDC_PROVIDER_DIR=<folder where npm i oidc-provider ran> npm run test:idp-interop`. Not yet tested against Entra, Okta or Google themselves.
- `hosts` is an allowlist: discovery, token and key endpoints must be https on one of those hosts. Redirects are never followed and response sizes are bounded.
- Startup fetches discovery and the signing keys and refuses to start if either fails or the issuer does not match exactly.
- Tokens must be RS256 or ES256, signed by a key from the provider's key set, with the exact issuer, your client id as audience, the nonce we issued, and a valid time window (default leeway 60 seconds, set `clockSkewSeconds` 0 to 300). Keys named in a token header are refused. A new key id triggers at most one key refetch a minute.
- `tenantId` pins the tenant claim (useful with Microsoft Entra, whose issuer is `https://login.microsoftonline.com/<tenant>/v2.0`). `allowedEmailDomains` requires a verified email in one of those domains; a token with no email cannot satisfy it.
- People who have not signed in before are created only if `autoProvision` is true, always as ordinary members. Make leaders with the admin CLI.
- `--disable-password-login` (requires `--oidc-config`) makes the server itself refuse password sign-in, not just hide the form. It also closes invitation redemption, its page, and password changes, so an old invitation cannot create a password account around the identity provider. Approving bounded work still needs fresh proof of who is at the keyboard. In this mode the person is sent back to your identity provider to sign in again (the request asks for `prompt=login` and `max_age=0`), and the answer is accepted only if the provider reports a sign-in time after the request, for the same person, in the same browser and the same session. The proof is good for five minutes and one approval. **Your provider must return the `auth_time` claim**; if it does not, approvals are refused, which is the safe failure. This has been tested against the built-in fake provider only, not a real Entra, Okta or Google tenant.
- Tested against an in-process fake provider that signs real tokens (`test/oidc-provider.test.mjs`), not against a real provider or a real Microsoft tenant. Try it with a test registration before relying on it.

