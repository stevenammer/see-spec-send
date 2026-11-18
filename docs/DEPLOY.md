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


## Putting it behind Cloudflare (or any CDN or WAF)

Cloudflare gives you TLS, DDoS protection, a web application firewall and rate limiting in front of the app. It's optional. I haven't run this setup against a real Cloudflare account, so treat the steps below as a checklist to verify, not a tested recipe.

The one thing that can go wrong quietly is the client address. The app rate-limits sign-ins per address (5 a minute, plus a growing lockout), and it takes that address from the **rightmost** `X-Forwarded-For` entry, and only when the connection comes from the same machine (loopback). If you chain Cloudflare to a proxy on the app's host and the proxy just appends what it sees, every visitor looks like a Cloudflare address and **everyone shares one sign-in bucket**. So:

1. Run the app with `--trusted-proxy` and keep its port private (loopback or a private network only).
2. On the proxy next to the app, **replace** `X-Forwarded-For` with the real visitor address instead of appending. With Caddy, `trusted_proxies cloudflare` (the Cloudflare module) does it. With nginx, use `real_ip_header CF-Connecting-IP;` plus `set_real_ip_from` for Cloudflare's published ranges, then `proxy_set_header X-Forwarded-For $remote_addr;`.
3. Make the origin refuse anything that didn't come through Cloudflare: firewall the proxy to Cloudflare's published IP ranges, or use Cloudflare Tunnel (`cloudflared`) so the origin has no public port at all. A tunnel on the same host reaches the app over loopback, which is what `--trusted-proxy` expects.
4. Set SSL/TLS mode to **Full (strict)** and pass `--origin https://your.host` so cookies and the same-origin check match the public address.
5. Don't cache. Pages and `/api/*` are per-person. Leave Cloudflare's "Cache Everything" off and let the app's own `Cache-Control` headers stand.
6. Turn on Cloudflare's managed WAF rules and a rate limit on `/api/login` and `/api/invite/redeem` as a second layer. The app's own limits stay on.

After it's up, check it from outside: `curl -I https://your.host/signin` should show `strict-transport-security` and the app's `content-security-policy`, and two different networks should not share a sign-in limit.

## Give the builder's work folder its own size limit

The builder container writes into a per-run folder under the builds root, and nothing in the app caps how many bytes or files it writes there before the 30-second wall clock ends. Put the builds root on its own volume with a size and inode limit (a separate filesystem, a quota, or a size-limited tmpfs) so a runaway build can't fill the disk the database lives on.
