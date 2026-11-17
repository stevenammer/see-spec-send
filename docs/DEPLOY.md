# Deployment

Build with `docker build -t see-spec-send .`. The image runs as `node`, has no application shell entrypoint, supports a read-only root filesystem, and checks `/readyz`.

Use a TLS-terminating proxy. Keep the app listener private and pass `--trusted-proxy` only when the proxy shares the host/network namespace. Mount `/data` as the single SQLite volume. Put secret material in root-readable files mounted read-only, then have the service manager export only the required environment-variable names. Never put secrets in Compose files.

Example: mount `sss-data:/data`, mount `audit:/audit`, run the app with `--audit-log /audit/events.jsonl`, and let the proxy own public port 443. The existing `compose.yaml` is an example topology, not a high-availability design.

Back up on a schedule with `node cli.js backup --to /backup/sss-$(date +%F).sqlite`, verify it, then ship both backup and manifest to object storage using your platform's authenticated agent. For warm standby on separate storage, run `node cli.js replicate --to /replica/sss --every 5m --keep 12`; see `HA.md`. Run `sh scripts/drill.sh` after upgrades and `npm run test:failover` before relying on standby. RPO is the actual backup interval. RTO is not promised: measure restore plus readiness time on your hardware and record the result. SQLite has one writer, no automatic failover, and this project does not claim HA.

## First run with the container image

The server refuses to start on a missing database, on purpose. Create it once, then run the server. The image has no install step (the application has no runtime dependencies), runs as an unprivileged user, and works with a read-only root filesystem and all capabilities dropped; only `/data` is writable.

```sh
docker build -t sss-app .
docker volume create sss-data
# One time: create the database and the first leader. It prints a one-time password; change it at first sign-in.
docker run --rm -v sss-data:/data --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node sss-app cli.js init --id your-leader-id
docker run -d --name sss -p 127.0.0.1:8080:8080 -v sss-data:/data --read-only --cap-drop ALL \
  --security-opt no-new-privileges sss-app
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/readyz     # 200
```

Put a TLS-terminating proxy in front (the entrypoint trusts the proxy's forwarded address, so never publish port 8080 directly), and pass `--origin https://your.host` and `--oidc-config` as extra arguments for sign-in through your identity provider. Verified: build, init, start, `/readyz` 200, read-only root.

