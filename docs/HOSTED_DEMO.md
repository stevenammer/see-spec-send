# Hosted demo (runbook for the owner)

Status: **the free Oracle quick-tunnel demo is running in fixture mode.** See [live evidence and pending checks](#observed-on-oracle). The named-tunnel setup below uses a Cloudflare account and your own domain. It has been exercised locally with Docker; the live deployment used the [free path](#free-path-oracle-always-free--cloudflare-quick-tunnel).

What it is: one invite-only instance, fixture lane only (canned Effort replies, a fake worker, no model provider, no builder containers), seeded with an invented roster and four invented stories, wiped and re-seeded every day at 00:00 UTC. Every page carries a banner saying so. It exists so a named reviewer can click through the real app without anyone's real data being near it.

## What you must supply for a named tunnel

| Thing | Notes |
| --- | --- |
| A domain on Cloudflare | One hostname, for example `demo.example.com`. |
| A Cloudflare Tunnel | Create it in the dashboard (Zero Trust, Networks, Tunnels, Cloudflared). Copy the token into `tunnel.env` on the host. Set the tunnel's public hostname service to `http://localhost:8080`. |
| A host with Docker (Compose v2) and systemd | arm64 or amd64. You supply the access. Nothing in this repository logs in anywhere. |
| The reviewer's account name | A short id such as `reviewer-ada`. You hand them the invite code yourself. |
| Your decision on who may reach it | Cloudflare Access in front is optional and recommended; see the settings below. |

The Cloudflare token is the only secret. It lives only in `deploy/hosted-demo/tunnel.env` (mode 0600, git-ignored). There is no model key, no cloud credential and no password in any file here.

## Commands

On the host, from a clean checkout at `/opt/see-spec-send` (change the paths in the three unit files if you use another place):

```sh
cd /opt/see-spec-send/deploy/hosted-demo
cp demo.env.example demo.env          # set SSS_ORIGIN=https://demo.example.com
cp tunnel.env.example tunnel.env && chmod 600 tunnel.env   # paste TUNNEL_TOKEN
./demo.sh build                       # builds sss-demo:local on this host (native arch)
./demo.sh init                        # first install only: creates and seeds the database
./demo.sh up                          # app, fake worker, tunnel
./demo.sh invite reviewer-ada         # prints a one-time code, valid 24 hours
```

Send the reviewer the code and the address `https://demo.example.com/redeem`. They pick their own password there. Unredeemed codes and every account are deleted by the daily reset, so issue a fresh code each day they need one.

Daily reset and start at boot:

```sh
sudo cp systemd/sss-demo.service systemd/sss-demo-reset.service systemd/sss-demo-reset.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sss-demo.service sss-demo-reset.timer
systemctl list-timers sss-demo-reset.timer       # next run should read 00:00:00 UTC
```

To build an arm64 image on an x86 machine instead: `PLATFORM=linux/arm64 ./demo.sh build` (needs buildx and QEMU emulation; not tried). The pinned base image `node:22-alpine@sha256:1314fb30...` is a multi-architecture index that includes `linux/arm64/v8` (checked read-only with `docker buildx imagetools inspect`), and so is the pinned `cloudflare/cloudflared` digest in `compose.yaml` (amd64 and arm64).

## What the reset guarantees

`deploy/hosted-demo/reset.js`, tested in `test/hosted-demo-reset.test.mjs` with an injected clock:

- It runs only from 00:00 to 00:10 UTC. `--force` lifts only the time window.
- It refuses a second reset in the same UTC day, forced or not. To redo a day's reset, wait for the next day or restore by hand.
- A forced reset outside the window sets the kill latch until the next UTC day, because replacing the database also wipes that day's spend counter. The next scheduled reset clears a latch it set itself. A latch you set with `kill set` is never cleared by the reset.
- `demo.sh reset` checks the guards before it stops anything, so a refusal causes no downtime. It always starts the stack again afterwards.
- The new database is built beside the old one and swapped in, so a failed seed or a failed ledger copy leaves yesterday's data in place.
- **The money ledger survives every reset.** Before the swap, the reset copies the gateway policy, the policy versions, the ledger counters and the Quest, Effort and analysis receipts from the old database into the new one, inside one transaction, then runs `PRAGMA integrity_check` and re-reads every receipt through the gateway code (so a bad seal or a short copy stops the reset and the old database stays). The lifetime cap (`global_micros`), the per-person counters and the day totals therefore keep counting across resets. Everything else (people, posts, accounts, invites, sessions, events) is replaced by the seed.
  - Builder-lane receipts (`gateway_receipts`) are tied to a run and an approval that the reset deletes, so a verbatim copy would fail the gateway's own check and stop every lane. They are rolled up instead: one sealed row per day, person `reset-carry`, in the analysis receipts table, with the same charged total. Day and lifetime totals are unchanged; the per-receipt detail of old builder calls is not kept.
  - Run tokens (`gateway_capabilities`) are not carried: they belong to runs that no longer exist.
  - Before this change a reset also reset the lifetime counter (`scripts/prove-daily-cap.mjs` case 2g shows a plain file replacement doing exactly that). `--init` on a first install has no earlier ledger, so nothing is carried.
  - The forced mid-day kill latch stays as before, as a second guard.

Proof: `test/hosted-demo-reset.test.mjs` (day and lifetime totals, policy, seals, wiped demo content, a failure mid-copy, a tampered receipt, a lifetime cap exhausted before the reset still refusing after it) and case 2g2 of `node scripts/prove-daily-cap.mjs`, which runs the real reset script on a copy of an exhausted database and shows the counters unchanged and the gateway still refusing with "day cap exceeded".

The timer has `Persistent=false` on purpose: a missed midnight must not turn into a mid-day reset.

## Free path: Oracle Always Free + Cloudflare quick tunnel

Status: **running on one Oracle VM in fixture mode.** The signed-out HTTPS checks and two scheduled backup and reset cycles passed through November 22, 2026. Use this when you have no domain and no Cloudflare account. It costs nothing, and it is the weaker option: Cloudflare describes quick tunnels as for testing, with no uptime guarantee, a limit of 200 in-flight requests, and no Server-Sent Events (this app does not send SSE to browsers). The address is a random `https://<words>.trycloudflare.com` and it **changes every time the tunnel restarts**.

Files: `deploy/hosted-demo/compose.quicktunnel.yaml` (instead of `compose.yaml`, never both), `tunnel-url.sh`, `backup.sh`, `systemd/sss-tunnel-sync.{service,timer}`, `systemd/sss-demo-backup.{service,timer}`. The token variant above is untouched.

### How the address change is handled (the origin)

The app checks that the `Origin` or `Referer` of every state-changing request equals the `--origin` it was started with, and it reads that once at startup. It cannot follow a new address while running, and I did not change that: loosening an origin check to accept whatever host arrives would weaken a security check for a convenience. So the safe approach is to restart the app with the new origin:

- `cloudflared` and the app both join a tiny holder container's network namespace (`netns`). Restarting the app does not restart the tunnel, so applying a new origin does not mint another address. (If `cloudflared` shared the app's own namespace, as in the token variant, restarting the app would restart the tunnel and chase its own tail.)
- `tunnel-url.sh` reads the address from cloudflared's metrics endpoint (`/quicktunnel`, pinned to `127.0.0.1:20241` with `--metrics`), falls back to the last `trycloudflare.com` log line, accepts nothing but a strict `<words>.trycloudflare.com` hostname, writes it to `deploy/hosted-demo/tunnel-url.txt`, and prints it. The `/quicktunnel` route is in cloudflared's source but I found no official Cloudflare page documenting it, so the log fallback exists. The first Oracle run verified the address change. It did not isolate which lookup supplied the new address.
- `demo.sh sync-origin` (run every minute by `sss-tunnel-sync.timer`) writes a changed address into `demo.env` and recreates the app and worker with it. Between a tunnel restart and the next sync (up to about a minute) the app refuses state-changing requests from the new address with 403. That fails closed; it is not a security hole. Sign-in and invite redemption are exempt from the origin check in the app, so they keep working.
- Every session cookie belongs to the old address, so after a restart each reviewer signs in again at the new one. You must re-send links: `cat deploy/hosted-demo/tunnel-url.txt`, and `./demo.sh invite NAME` for anyone who never redeemed. The invite page is `<address>/redeem`.
- The daily reset leaves the tunnel running, so the address survives midnight. It changes only if cloudflared restarts (a crash, a host reboot, a Docker restart) or you stop the stack.

### Owner steps

1. Oracle: Always Free VM (Ampere A1 arm64 or the small x86), Ubuntu. Install Docker Engine with Compose v2 and `flock` (util-linux, usually present). Reach it over Tailscale. Open **no** inbound ports in the Oracle security list for this demo (the tunnel only goes outbound).
   If Docker was installed without the Compose plugin (it was on the first real deployment, Docker 29 on Ubuntu 24.04 arm64), the plugin can live in the user's home without touching system packages: download the official `docker-compose-linux-aarch64` (or `-x86_64`) binary from the Docker Compose releases page, verify it against the release's `checksums.txt` with `sha256sum -c`, and put it at `~/.docker/cli-plugins/docker-compose` (mode 755). A user-local plugin is invisible to root, so add `User=<your user>` as the first line under `[Service]` in each `.service` file before installing the units.
2. Clone the repo to `/opt/see-spec-send` (or change the paths in the unit files).
3. In `/opt/see-spec-send/deploy/hosted-demo`:
   ```sh
   cp demo.env.example demo.env
   # edit demo.env: uncomment SSS_MODE=quicktunnel (leave SSS_ORIGIN as the placeholder; it is overwritten)
   sudo mkdir -p /var/backups/sss-demo && sudo chown 1000:1000 /var/backups/sss-demo
   echo 'SSS_BACKUP_DIR=/var/backups/sss-demo' >> demo.env   # compose mounts it into the tools container
   ./demo.sh build
   ./demo.sh init
   ./demo.sh up      # starts the tunnel, waits for the address, starts app + worker on it, prints the address
   ```
4. Units: `sudo cp systemd/sss-demo.service systemd/sss-demo-reset.service systemd/sss-demo-reset.timer systemd/sss-tunnel-sync.service systemd/sss-tunnel-sync.timer systemd/sss-demo-backup.service systemd/sss-demo-backup.timer /etc/systemd/system/`, then `sudo systemctl daemon-reload && sudo systemctl enable --now sss-demo.service sss-demo-reset.timer sss-tunnel-sync.timer sss-demo-backup.timer`. The existing `sss-demo.service` and reset service work unchanged: `demo.sh` switches behavior on `SSS_MODE=quicktunnel` in `demo.env`.
5. Run the two-network test below with a throwaway account. Invite reviewers only after it passes.
6. Then `./demo.sh invite reviewer-ada`, and send the code with the current address from `tunnel-url.txt`.

Kill ladder for this path: `./demo.sh kill set`; then `docker compose -f compose.quicktunnel.yaml stop cloudflared` (a restarted quick tunnel is a different address, so every old link stays dead); then `./demo.sh down`.

### Two-network test of the real visitor address (copy and paste)

The app buckets sign-in attempts by the rightmost `X-Forwarded-For` entry, believed only from a loopback peer. Cloudflare appends the visitor's address as the rightmost entry, and `cloudflared` reaches the app over loopback. `test/hosted-demo-quicktunnel.test.mjs` proves the app's half of that with a loopback stand-in proxy that appends the visitor (including a spoofed incoming header). The first Oracle deployment recorded separate failure buckets for two real networks and ignored spoofed header values. This procedure goes one step further and checks that an invited reviewer can still sign in from the second network while the first is limited.

Setup, once: make a throwaway account and redeem it (the daily reset deletes it). `./demo.sh invite reviewer-test` prints a code; open `<address>/redeem` in a browser and choose a test password. Then, on **network A** (for example your laptop on home Wi-Fi), with `URL` set to the address from `tunnel-url.sh` and `PW` the test password:

```sh
URL=https://your-words-here.trycloudflare.com
PW='the-test-password'
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "A bad try $i: %{http_code}\n" -X POST "$URL/api/login" \
    -H 'content-type: application/json' -H "x-forwarded-for: 192.0.2.$i" \
    -d '{"id":"nobody-'$i'","password":"wrong-password-1"}'
done
curl -s -o /dev/null -w "A right password, 6th try: %{http_code}\n" -X POST "$URL/api/login" \
  -H 'content-type: application/json' -H 'x-forwarded-for: 192.0.2.77' \
  -d '{"id":"reviewer-test","password":"'"$PW"'"}'
```

Expected on A: five `400` lines, then `400` for the sixth even though the password is right (that is the limit, and the invented `x-forwarded-for` values must not have bought a fresh bucket). Then, within a minute, on **network B** (a phone on mobile data with Wi-Fi off, or a cloud shell elsewhere):

```sh
curl -s -o /dev/null -w "B right password, first try: %{http_code}\n" -X POST "$URL/api/login" \
  -H 'content-type: application/json' -d '{"id":"reviewer-test","password":"'"$PW"'"}'
```

- **Pass:** A's sixth is `400` and B's first is `200`.
- **Fail, B is also `400`:** every visitor shares one address. Stop, take the tunnel down, invite no one.
- **Fail, A's sixth is `200`:** the app believed the spoofed header, or A was not limited. Same action.

Wait a few minutes for the buckets to refill before re-running. Both networks need the same `URL`; if the tunnel restarted in between, start over.

### Nightly backup

`sss-demo-backup.timer` runs `backup.sh` at 23:30 UTC, before the 00:00 reset. It uses the app's own backup command (SQLite `VACUUM INTO`: one consistent snapshot that is safe while the app runs, then verified and given a manifest), never a raw copy of the database file. It writes to `/var/backups/sss-demo`, a second directory mounted into the tools container only, and keeps the newest 7 (`SSS_BACKUP_KEEP` in the unit).

What it protects: **the demo's people, posts and accounts are disposable** (the reset wipes and re-seeds them every day anyway). **The gateway ledger and policy are not**: the lifetime cap and the per-day counters live in that database, and restoring an old backup rolls the spend counters back to that day. After any restore, keep the kill latch on (`cli.js restore` starts the copy stopped), compare the ledger with what you know was spent, and only then `./demo.sh kill clear`. The fixture lane makes no model calls, so today the ledger holds nothing of value; it matters the day a real model lane is switched on. The backup directory is on the same VM, so it does not protect against losing the VM.

### The honest catches

- **Links die.** Every cloudflared restart (crash, Docker restart, VM reboot) gives a new address and kills all old links. Re-send the new address; reviewers sign in again.
- **No uptime promise.** Cloudflare says quick tunnels are for testing. It may be slow, rate limited or down.
- **Oracle may reclaim an idle Always Free VM.** Oracle's documentation says idle Always Free instances can be reclaimed. I have not confirmed whether upgrading the account to Pay As You Go prevents that, so do not rely on it.
- **Shared VM.** This VM also runs your other apps. Use only this locked-down compose file: no Docker socket in any container, no volumes shared with your other apps, no host networking, nothing published. `tunnel-url.sh` and `demo.sh` call `docker` from the host (root under systemd); no container gets that power.
- **No Cloudflare Access, WAF or rate-limit rules** on a quick tunnel (those need an account). Only the app's own limits stand, plus invite-only sign-in.
- **Recovery window.** During the live midnight resets, the app and worker took about 12 seconds to stop and start. Recovery after a VM reboot is still untested.

### Don't deploy if

- You cannot run the two-network test from two genuinely different networks.
- You need a link that stays the same for days, or reviewers you cannot re-send a link to.
- Anything else on the VM needs the Docker socket, a shared volume, host networking, or the same user as this stack.
- You plan to turn on a model lane (Vertex or any provider). Put a named tunnel and Cloudflare Access in front first and read the Vertex section below.
- The VM is the only copy of anything you care about.

## Optional later: a real model lane through Vertex AI (documentation only; nothing here is enabled or has been run)

The hosted demo ships with the fixture lane only. If the owner later decides to let the demo's Quest, Effort and analysis lanes call a real model, this is the shape. Nothing below was run, no credential exists in this repository, and no call was made.

Honest scope: Gemini has only been evaluated in this repository as a **builder** (`docs/BUILDER_EVAL.md`). It has not been evaluated in the Quest, Effort or ask lanes, so its answers there are untested here, and the demo's reviewers would be the first to see them.

1. **Provider entry.** `deploy/hosted-demo/vertex.provider.example.json` is a template (kind `vertex`, signed in with a service account that lives on the host, never in the file). Use a Google Cloud project of its own, give the service account only the Vertex AI User role, set a budget alert, and keep the key file mode 0600 and owned by the service user. The provider file also supports Vertex express mode (an API key read from an environment variable or private file, through the Gemini native endpoint), but the service-account form is the one documented here. Add a filled-in copy with `node cli.js provider add --file vertex.provider.json`.
2. **Price table: UNVERIFIED.** The entry carries 300000 input and 2500000 output micro-dollars per million tokens, the figures already in `docs/PROVIDERS.md` for Gemini 2.5 Flash. I could not confirm them against Google's current price page (it did not render its table when fetched), so treat them as unconfirmed. Before any call the operator must read the current Vertex AI price for the exact model and region and set the entry to that price or higher. The gateway meters with this table; a table below the real price makes the cap undercount.
3. **Gateway policy.** `deploy/hosted-demo/gateway-policy.vertex.example.json`: `day_micros` 15000000 ($15 per UTC day) and `global_micros` 100000000 as a **placeholder** for the lifetime tranche. The owner decides the real number; the reset now keeps it, so it bounds spend across every day. Apply with `node cli.js gateway policy set --file policy.json`. Keep the kill latch ready (`./demo.sh kill set`).
4. **Wiring.** The compose file runs the app with `--enable-effort --fixture`. A real lane needs the provider file and key mounted into the app container and flags such as `--enable-quest-model --quest-provider vertex-flash` and `--analysis-provider vertex-flash`. That change to `compose.yaml` is deliberately not made here; it would break the "no provider flags, `provider list` stays empty" promise the compose file makes today, so decide it on purpose.
5. **First test: one tiny approved smoke test, at most a few cents.** After the owner approves in writing, run `node cli.js provider test --name vertex-flash --max-output 1` once on the host. It prints its worst-case reservation first and makes exactly one call. Then, with the day cap temporarily at about 50000 micro-dollars ($0.05), make one Quest draft as the reviewer, read the answer, and check `node cli.js gateway status` shows the charge. Only after that raise the cap to its planned value. Stop at the first surprise.
6. **Not done:** no live call, no price check against the vendor, no Quest/Effort/ask-lane quality evaluation for Gemini, no test of the token exchange against Google.

## Cloudflare settings to apply (a checklist to verify, not a tested recipe)

1. SSL/TLS mode **Full (strict)**. (With a tunnel the hop to the origin is inside the tunnel; the setting still governs the edge.)
2. **WAF** managed rules on.
3. Rate limiting rules on `/api/login` and `/api/invite/redeem` (for example 10 requests a minute per address, block for a minute). The app's own limits stay on underneath.
4. **Caching off**: no "Cache Everything", a bypass rule for the whole hostname. Pages are per person.
5. Optional but recommended: a Cloudflare Access policy that allows only the reviewers' email addresses, so the sign-in page is not open to the internet at all.
6. Bot Fight Mode is your call; it can block a reviewer's browser.

## Kill-switch ladder (fastest and least destructive first)

1. **Cloudflare:** add a block rule for the hostname, or switch the Access policy to deny. No host access needed.
2. **App stop latch:** `./demo.sh kill set`. Stops runs, refuses new spend. `./demo.sh kill status` shows it. `./demo.sh kill clear` is deliberate.
3. **Stop the tunnel:** `docker compose stop cloudflared` from `deploy/hosted-demo`. The app stays up but unreachable.
4. **Stop everything:** `./demo.sh down` (data volume kept).
5. **Remove it:** delete the tunnel or the DNS record in Cloudflare, then `docker compose down -v` to delete the data volume. Revoke the tunnel token in the dashboard.

## After deploy: test from outside (not from the host)

Do these from a phone on mobile data and from one other network.

- [ ] `curl -sI https://demo.example.com/signin` shows `strict-transport-security` and a `content-security-policy`, and the page body contains the demo banner.
- [ ] `curl -sI http://demo.example.com/signin` does not serve the app over plain HTTP (redirects or refuses).
- [ ] The origin is not reachable directly: `nmap` or a browser against the host's public address finds nothing on 8080, 8787 or 443 belonging to this app.
- [ ] Redeem a fresh invite as the reviewer, sign in, open the feed, open the four seeded items, post one comment.
- [ ] Reuse the same invite code: it must be refused.
- [ ] Six wrong passwords from network A are refused with the limit. Then one try from network B is judged on its own (this is the real-address check: if B is also limited, every visitor shares one address, and you must stop and fix the proxy path before inviting anyone).
- [ ] `curl -s https://demo.example.com/metrics-lite` and `/admin` refuse a signed-out caller.
- [ ] No cookie is served with `Cache-Control` that allows caching; a second visitor never sees the first visitor's page (check the `cf-cache-status` header reads `DYNAMIC` or is absent).
- [ ] After midnight UTC: the reviewer's account is gone, the four stories are back, `./demo.sh kill status` reads `clear` (unless you set it), and `systemctl status sss-demo-reset.service` shows a clean run.
- [ ] Tell the reviewer what the banner says, in words, before they start.

## Observed on Oracle

- The free path was deployed on one Always Free ARM VM (Ubuntu 24.04, Docker 29.1, user-local Compose v5.8). The initial external sign-in and readiness checks returned HTTP 200. The sign-in page showed the demo banner and returned HSTS and CSP headers. The provider list was empty. The sign-in logs showed two separate network buckets and ignored spoofed forwarding addresses.
- One deliberate tunnel restart changed the address. The app followed the new origin in about seven seconds. The deployment also exposed two scripts with missing executable bits, fixed in `da426d8`.
- The scheduled 23:30 UTC backups on November 20 and 21 completed. The verification command reported 16 events in each backup, and both files matched the SHA-256 hashes in their manifests. The scheduled midnight resets on November 21 and 22 finished in about 12 seconds. Both logs showed the fixture gateway ledger carried forward, the kill latch clear, and the app and worker started again. The live `/signin` and `/readyz` still returned HTTP 200 on November 22.

## Pending checks

- A reviewer successfully signs in from one network while another is limited. The initial live check used failure logs and did not issue an invite. Complete the reviewer sign-in check in the two-network procedure before handing the demo to reviewers.
- Recovery after a VM reboot and a longer availability record.
- Ledger carry after sustained real provider use. The live demo uses fixtures. The automated cap proof covers simulated receipts and all four model lanes.
- An independent review. The demo inherits the open items in [SECURITY_WATCH.md](SECURITY_WATCH.md) and [THREAT_MODEL.md](THREAT_MODEL.md).
