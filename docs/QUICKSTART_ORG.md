# Organization quickstart

This is a local, single-host start. It uses SQLite and local passwords. Identity-provider and Postgres seams are built but not usable: neither has a real verifier or driver, respectively.

```sh
export SSS_DB="$PWD/data/sss.db"
mkdir -p data
node cli.js init --id leader
node cli.js serve --port 8787 --origin http://127.0.0.1:8787 --insecure-cookies
```

In other terminals, run `node cli.js worker` and `node cli.js watchdog`. The watchdog fails closed: a stale heartbeat, a run beyond its cap, or an old dead or sending outbox record sets the existing emergency stop and records `watchdog.stop`. Clear it only after investigating: `node cli.js kill clear`.

## HTTPS on a network: the one documented path

Compose is the supported way to serve this on a network. It publishes only on `127.0.0.1:8443`. A TLS front end (`deploy/tls-front.conf`, nginx) terminates HTTPS and shares the server's network namespace, so it reaches the server over loopback. The server runs with `--trusted-proxy`, which believes a forwarded address only from that loopback peer. Secure cookies and HSTS are on.

You need: a certificate and key in `deploy/tls/` (`fullchain.pem`, `privkey.pem`, never committed), the public origin, and the nginx image pinned by digest. Compose refuses to start until `SSS_ORIGIN` and `SSS_TLS_IMAGE` are set.

```sh
export SSS_ORIGIN=https://sss.example.org
export SSS_TLS_IMAGE='nginxinc/nginx-unprivileged@sha256:<digest you resolved>'
docker compose run --rm --user root --entrypoint chown server -R 1000:1000 /data   # first run only
docker compose run --rm server node cli.js init --id leader   # prints the leader's initial password
docker compose up
```

Because the compose file publishes only on `127.0.0.1:8443`, something on the host must forward public HTTPS to it (a host reverse proxy, firewall rule, or tunnel). That edge is your setup, not part of this file.

Running without Compose uses `docs/systemd/see-spec-send-server.service` and `see-spec-send-worker.service`. The server still needs a TLS front end on the same host. Direct HTTPS is `serve --tls-cert FILE --tls-key FILE` for a single host with no proxy. `serve` refuses any non-loopback bind without one of those, and refuses `--insecure-cookies` anywhere except loopback.

The container builder is optional. It needs its pinned image, a Unix gateway socket (`gateway serve --socket`), and the Docker socket for the worker, which is root on the host. Setup is in [ADMIN.md](ADMIN.md) under "Model-built tries". Don't turn it on just because Compose is running.

## Backup and restore drill

Stop the server and worker first. A SQLite backup does not include the independent `.kill` latch.

```sh
SSS_DB="$PWD/data/sss.db" node cli.js backup --to "$PWD/data/sss.db.backup"
SSS_DB="$PWD/data/drill.db" node cli.js restore --from "$PWD/data/sss.db.backup"
SSS_DB="$PWD/data/drill.db" node cli.js verify
```

The restore target must not exist. Keep the backup owner-readable only. `npm test`
includes a minimal offline backup/restore check over an empty database, not a
meaningful recovery drill. Do not rely on it as production restore proof.
