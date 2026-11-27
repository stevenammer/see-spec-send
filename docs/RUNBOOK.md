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
- Schedule it: `docs/systemd/see-spec-send-backup.service` runs `node cli.js replicate --every 1h --keep 72` as a service.
- Verify without touching live data: `node cli.js backup verify --from <backup>`.
- Restore: `node cli.js restore --from <backup>` into a new `SSS_DB`. The restored copy starts with the stop latch set. Clear it deliberately once you have checked it.
- Prune old backups: `node cli.js backup prune --dir <dir> --keep N`. It never removes the newest backup or one that fails verification.
- A backup does not include the separate stop-latch file. Re-set the latch after a restore if you need it.

## 3a. Warm standby (continuous verified backups, not high availability)

Use a separate machine or storage device for the replica directory. On the primary, run `node cli.js replicate --to /replica/sss --every 5m --keep 12` under a service manager, or use `--once` from cron. Each copy is verified before `latest.json` changes. A failed copy leaves the previous good `latest.json` and backup in place. This is still one SQLite writer, with manual, fenced promotion.

After the old primary is confirmed stopped, promote only into a new path: `node cli.js standby --from /replica/sss --db /data/promoted.sqlite --max-age 15m`. It refuses a stale replica, and also refuses a very recent replica because the primary may still be alive. `--force` bypasses either fence only after an operator has resolved that risk. The promoted copy starts stopped; check it, then clear the latch before serving it. Run `npm run test:failover` on hardware that permits loopback sockets to measure actual RTO and one-interval RPO loss.

## 3b. Moving to another installation (export and import)

A backup is a copy of the same database. An export is a portable, readable file you can take anywhere.

- Export: `node cli.js export > org.jsonl`. It carries people (as ids, not accounts), every event, artifacts, the groups that define who can read restricted work, the whole knowledge log (updates, corrections, receipts, analysis records), what was erased, and the small delivery state that stops a copy from announcing everything again. Erased records leave only their hashes, never their text.
- Import: `SSS_DB=<a path that does not exist> node cli.js import --from org.jsonl`. It refuses an existing database, verifies every chain after loading, and removes everything it created if anything is wrong.
- Treat an export like code you are about to run: it can name any person, any past decision and any recorded authority. Import only a file you made yourself, or sign it: `node cli.js export --sign-key export.key > org.jsonl` (the key file is created for you, 32 random bytes, mode 0600) and `import --from org.jsonl --verify-key export.key`, which refuses a file whose signature does not match or is missing, before anything is created.
- Imports never carry current leader authority: past decisions by leaders stay recorded and verify, but everyone becomes an ordinary member until you promote people with `node cli.js person promote`. Pass `--keep-leaders` only for a file you trust completely.
- Not exported: accounts and passwords, and private mentoring. After an import, run `node cli.js init --id <leader>` to create the first leader and invite everyone else, or turn on single sign-on.
- Check before you switch: run `node cli.js verify` and `node cli.js doctor` on the new database, open a restricted item as a member and as a non-member, and run `node cli.js reanalysis run` and confirm it announces nothing new.

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
- **Someone left the organization:** disable them (`node cli.js person disable`, or the administration page). A leader can then reassign any post they were stewarding at once, with a note, instead of waiting 14 days; the handoff records that the steward had left. Their credit stays on the work.
- **Rotate secrets:** the bundle-origin signing secret is random per process, so a restart rotates it. Provider credentials live in the service environment only; rotate them there and restart. Replace any key file you used for backups.
- **Remove content:** `node cli.js erase --item ... --body-hash ... --actor ... --reason ...`. Derived records built from it are tombstoned in the same step. Backups are not changed.
- **After any incident:** run `node cli.js verify` and `node cli.js doctor`, keep the logs, and write down the timeline.

## 5b. The identity provider is down, or nobody can sign in

Single sign-on only (`--disable-password-login`) means an outage at the provider is an outage here. Plan for it before it happens:

1. Keep at least one named break-glass leader who has a password account and know that the switch is a server start option, not data. To get in, stop the server and start it again **without** `--disable-password-login` (and, if the provider itself is unreachable at startup, without `--oidc-config`). Existing sessions and all data are unaffected.
2. Sign in with the break-glass account, do what is needed, then restart with the original options. Every sign-in and admin change is in the audit log (`node cli.js audit export`).
3. If no password account exists, create one from the machine itself: `node cli.js invite create --role member`, redeem it, then promote that person with `node cli.js person promote`. These commands need access to the database file, which is why host access is the real break-glass control. Guard it accordingly.
4. After the outage, review the audit log for the window and rotate that break-glass password.

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
- Rechecked November 27, 2026 on a busy laptop (load average about 3 on 4 cores). With 300 seeded items, 40 workers: about 147 requests per second, median about 250 ms, 99th percentile under 0.6 s for reads; posting's 99th percentile was 2.6 s (one SQLite writer). With 1,000 seeded items the same load gave about 95 requests per second, median about 380 ms, reads' 99th percentile about 1 s and posting's about 5 s. The feed's cost grows with the number of items, so a long-running workspace should be measured again before it grows past a department.

Limits you should know: one SQLite writer on one machine, no clustering, no replication. Measure your own hardware with `node scripts/load.mjs` before growing, and look at the 99th percentile and the 429 rate, not only the average.

## 9. Nightly mutation checks

Mutation checks break one rule at a time in a throwaway copy and confirm a test catches it. A survivor means a rule has no test that would notice it being removed.

- `scripts/mutate-new.mjs` runs the scoped mutants for the newest modules (about an hour).
- `scripts/mutate-check.mjs` is the long campaign (419 mutants, more than a day end to end), so it runs one tenth a night: `--shard K/N` runs every Nth mutant starting at K.
- `scripts/nightly-mutants.sh` does both from a clean export of the newest pushed `main`, at low priority, under a lock, and writes `~/.local/state/see-spec-send/mutation/YYYY-MM-DD.log`, `latest.txt` (one line: commit, shard, killed, survived) and `survivors.txt` (every survivor, dated). Install it with the cron line in the script header, read `latest.txt` each morning, and treat any survivor as a missing test.
- `node scripts/mutate-check.mjs --check-sources` (and the same flag on `mutate-new.mjs`) confirms every mutant still matches real source, so a refactor cannot silently turn a mutant into a no-op.

