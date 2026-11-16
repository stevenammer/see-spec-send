# Runbook

Plain steps for the person running this. Everything here uses commands that exist in this repository. Where something is not proven, it says so.

## 1. Install from scratch

1. Install Node 22.19 or newer. Tests were run on 22.23.
2. Choose a data directory that only the service account can read, and set `SSS_DB` to a file in it.
3. `node cli.js init --id <your-id>` creates the database (mode 0600) and prints a one-time password. Sign in, replace it when asked, and keep the new one in your password manager.
4. Put a TLS front end in front of the server (see QUICKSTART_ORG.md). The server itself serves plain HTTP on loopback.
5. Start `node cli.js serve ...`. Check `/healthz` and `/readyz`.
6. Run `node cli.js doctor` and read every line.

`scripts/drill.sh` runs steps 3 to 6, a crash, a backup, and a restore inside a throwaway container. It passed 18 of 18 checks on the last run.

## 2. Upgrade and roll back

1. `node cli.js backup --to <dir>/before-upgrade` while the server and worker are stopped.
2. Replace the code. Run `node cli.js migrate --check` and read what it says is pending.
3. Start the new code. Migrations run once at startup and keep a copy beside the database.
4. Run `node cli.js doctor` and `/readyz`.
5. Roll back by stopping, restoring the backup (`node cli.js restore --from <backup>` into a new path), and starting the old code against the restored copy. A database stamped with a newer schema refuses to open with older code, by design; do not edit the version number.

## 3. Backup and restore drill

Run this on a schedule you can stand behind, and after every upgrade.

- Back up: `node cli.js backup --to <new path>` (add `--encrypt-to <key file>` to encrypt; the key is never stored in the backup).
- Verify without touching live data: `node cli.js backup verify --from <backup>`.
- Restore: `node cli.js restore --from <backup>` into a new `SSS_DB`. The restored copy starts with the stop latch set. Clear it deliberately once you have checked it.
- Prune old backups: `node cli.js backup prune --dir <dir> --keep N`. It never removes the newest backup or one that fails verification.
- A backup does not include the separate stop-latch file. Re-set the latch after a restore if you need it.

## 4. What can and cannot be recovered

| Case | Recoverable? |
| --- | --- |
| Server or machine crash during a write | Yes. The drill kills the server mid-write and every chain still verifies. |
| Lost database file, backup exists | Yes, back to the time of the backup. Anything after it is lost. There is no continuous replication. |
| Lost database and no backup | No. |
| An erased item | Not from the live database. Copies in earlier backups and in frozen packet copies can survive; see PRIVACY_DATA_MAP.md. |
| A tampered backup | Detected on restore and refused. |
| A lost backup encryption key | Not recoverable. |

Recovery point objective equals your backup interval. Recovery time is the time to restore one file and start the server; measure it on your hardware.

## 5. Incident response

- **Stop everything now:** `node cli.js kill set`. It sets a file latch and a database latch, stops running builds, and refuses new spend. `kill status` shows it; `kill clear` is deliberate.
- **A capability or token leaked:** `node cli.js gateway revoke ...` for model capabilities; end sessions with `node cli.js session revoke`; disable a person with `node cli.js person disable`.
- **Rotate secrets:** the bundle-origin signing secret is random per process, so a restart rotates it. Provider credentials live in the service environment only; rotate them there and restart. Replace any key file you used for backups.
- **Remove content:** `node cli.js erase --item ... --body-hash ... --actor ... --reason ...`. Derived records built from it are tombstoned in the same step. Backups are not changed.
- **After any incident:** run `node cli.js verify` and `node cli.js doctor`, keep the logs, and write down the timeline.

## 6. What to monitor and alert on

| Signal | Where | Alert when |
| --- | --- | --- |
| Liveness | `GET /healthz` | Not 200 for two checks in a row |
| Readiness | `GET /readyz` | 503 (schema mismatch or database unreadable) |
| Backup age | `doctor --backup-dir` | Newest backup older than your objective |
| Chain integrity | `doctor`, `metrics-lite` (`knowledge.chain`) | Anything other than ok |
| Kill latch | `readyz` (`kill_latch`) | stopped when you did not set it |
| Gateway spend | `metrics-lite` (`gateway_receipts`), `gateway status` | Held receipts growing, or a cap near |
| Digest backlog | `metrics-lite` (`digest_backlog`) | Growing for days |
| Errors | request counts by route and status class | A rising 5xx class |
| Disk | `doctor` (`disk_headroom_bytes`) | Under your threshold |

`/metrics-lite` needs a leader session or a bearer token whose environment variable name you set in `SSS_METRICS_TOKEN_ENV`. It contains counts only: no person ids, no addresses, no query strings.

## 7. Logs

The server writes one JSON line per request and per sign-in event to standard error: a request id, the route template, the status, a duration, and the signed-in person id where there is one. It never logs passwords, tokens, cookies, request bodies or model text. Keep logs for as long as your own policy says; this project does not decide that. Treat the person id as personal data when you set retention.

## 8. Capacity (measured, one laptop, not a promise)

Measured with `scripts/load.mjs` on one machine, SQLite, one server process:

- 40 concurrent workers with no pauses: about 160 requests per second, median about 220 ms, 99th percentile under 0.7 s, no errors apart from the per-member write limit (HTTP 429), which is working as designed.
- First reanalysis pass over 1,000 items: about 5.5 s. A pass with nothing new: about 0.1 s.
- Sign-in is rate limited per address, so a burst of sign-ins from one place is refused.

Limits you should know: one SQLite writer on one machine, no clustering, no replication. Measure your own hardware with `node scripts/load.mjs` before growing, and look at the 99th percentile and the 429 rate, not only the average.

## 9. Nightly mutation checks

Mutation checks break one rule at a time in a throwaway copy and confirm a test catches it. A survivor means a rule has no test that would notice it being removed.

- `scripts/mutate-new.mjs` runs the scoped mutants for the newest modules (about an hour).
- `scripts/mutate-check.mjs` is the long campaign (419 mutants, more than a day end to end), so it runs one tenth a night: `--shard K/N` runs every Nth mutant starting at K.
- `scripts/nightly-mutants.sh` does both from a clean export of the newest pushed `main`, at low priority, under a lock, and writes `~/.local/state/see-spec-send/mutation/YYYY-MM-DD.log`, `latest.txt` (one line: commit, shard, killed, survived) and `survivors.txt` (every survivor, dated). Install it with the cron line in the script header, read `latest.txt` each morning, and treat any survivor as a missing test.
- `node scripts/mutate-check.mjs --check-sources` (and the same flag on `mutate-new.mjs`) confirms every mutant still matches real source, so a refactor cannot silently turn a mutant into a no-op.

