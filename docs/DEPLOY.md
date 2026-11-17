# Deployment

Build with `docker build -t see-spec-send .`. The image runs as `node`, has no application shell entrypoint, supports a read-only root filesystem, and checks `/readyz`.

Use a TLS-terminating proxy. Keep the app listener private and pass `--trusted-proxy` only when the proxy shares the host/network namespace. Mount `/data` as the single SQLite volume. Put secret material in root-readable files mounted read-only, then have the service manager export only the required environment-variable names. Never put secrets in Compose files.

Example: mount `sss-data:/data`, mount `audit:/audit`, run the app with `--audit-log /audit/events.jsonl`, and let the proxy own public port 443. The existing `compose.yaml` is an example topology, not a high-availability design.

Back up on a schedule with `node cli.js backup --to /backup/sss-$(date +%F).sqlite`, verify it, then ship both backup and manifest to object storage using your platform's authenticated agent. Run `sh scripts/drill.sh` after upgrades and at least quarterly. RPO is the actual backup interval. RTO is not promised: measure restore plus readiness time on your hardware and record the result. SQLite has one writer, no replication, and this project does not claim HA.
