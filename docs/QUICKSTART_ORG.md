# Organization quickstart

This is a local, single-host start. It uses SQLite and local passwords. Production identity and Postgres are optional seams, not exercised here.

```sh
export SSS_DB="$PWD/data/sss.db"
mkdir -p data
node cli.js init --id leader
node cli.js serve --port 8787 --origin http://127.0.0.1:8787 --insecure-cookies
```

In other terminals, run `node cli.js worker` and `node cli.js watchdog`. The watchdog fails closed: a stale heartbeat, a run beyond its cap, or an old dead or sending outbox record sets the existing emergency stop and records `watchdog.stop`. Clear it only after investigating: `node cli.js kill clear`.

`compose.yaml` starts those three processes with the `sss-data` persistent volume:

```sh
docker compose run --rm server node cli.js init --id leader   # prints the leader's one-time password
docker compose up
```

Then open http://127.0.0.1:8787/signin. The compose file serves on all interfaces inside its container (`--host 0.0.0.0`) with insecure cookies, which is for trying it on your own machine. Put it behind HTTPS and drop `--insecure-cookies` before real use.

The container builder is optional. It needs its pinned image, a Unix gateway socket, and the separate setup in [ADAPTER.md](ADAPTER.md). Don't turn it on just because Compose is running.

## Backup and restore drill

Stop the server and worker first. A SQLite backup does not include the independent `.kill` latch.

```sh
SSS_DB="$PWD/data/sss.db" node cli.js backup --to "$PWD/data/sss.db.backup"
SSS_DB="$PWD/data/drill.db" node cli.js restore --from "$PWD/data/sss.db.backup"
SSS_DB="$PWD/data/drill.db" node cli.js verify
```

The restore target must not exist. Keep the backup owner-readable only. `npm test` includes an offline backup and restore drill.
