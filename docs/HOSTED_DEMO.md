# Hosted demo (runbook for the owner)

Status: **built, not deployed.** No hosted demo exists yet. Everything here was run on a laptop with Docker, with no Cloudflare account, no domain and no second machine. Parts that could not be checked there are listed at the end under "Not verified".

What it is: one invite-only instance, fixture lane only (canned Effort replies, a fake worker, no model provider, no builder containers), seeded with an invented roster and four invented stories, wiped and re-seeded every day at 00:00 UTC. Every page carries a banner saying so. It exists so a named reviewer can click through the real app without anyone's real data being near it.

## What you must supply

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
- The new database is built beside the old one and swapped in, so a failed seed leaves yesterday's data in place.

The timer has `Persistent=false` on purpose: a missed midnight must not turn into a mid-day reset.

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

## Not verified

- Cloudflare's real-address behavior with this setup. The app takes the rightmost `X-Forwarded-For` entry and only from a loopback connection; `cloudflared` shares the app's network namespace so the connection is loopback, but whether the header it carries holds the visitor's address was not observed. The two-network test above is how you find out.
- Anything on the real host: Docker version, systemd timer firing, the host's arm64 build and run.
- The 00:00 UTC reset on a real clock. Tests inject the clock; the container run used `--force` because it was mid-day.
- No outside party has tested this. It inherits the open items in `docs/SECURITY_WATCH.md` and `docs/THREAT_MODEL.md`.
