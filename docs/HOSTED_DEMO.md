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
- The new database is built beside the old one and swapped in, so a failed seed or a failed ledger copy leaves yesterday's data in place.
- **The money ledger survives every reset.** Before the swap, the reset copies the gateway policy, the policy versions, the ledger counters and the Quest, Effort and analysis receipts from the old database into the new one, inside one transaction, then runs `PRAGMA integrity_check` and re-reads every receipt through the gateway code (so a bad seal or a short copy stops the reset and the old database stays). The lifetime cap (`global_micros`), the per-person counters and the day totals therefore keep counting across resets. Everything else (people, posts, accounts, invites, sessions, events) is replaced by the seed.
  - Builder-lane receipts (`gateway_receipts`) are tied to a run and an approval that the reset deletes, so a verbatim copy would fail the gateway's own check and stop every lane. They are rolled up instead: one sealed row per day, person `reset-carry`, in the analysis receipts table, with the same charged total. Day and lifetime totals are unchanged; the per-receipt detail of old builder calls is not kept.
  - Run tokens (`gateway_capabilities`) are not carried: they belong to runs that no longer exist.
  - Before this change a reset also reset the lifetime counter (`scripts/prove-daily-cap.mjs` case 2g shows a plain file replacement doing exactly that). `--init` on a first install has no earlier ledger, so nothing is carried.
  - The forced mid-day kill latch stays as before, as a second guard.

Proof: `test/hosted-demo-reset.test.mjs` (day and lifetime totals, policy, seals, wiped demo content, a failure mid-copy, a tampered receipt, a lifetime cap exhausted before the reset still refusing after it) and case 2g2 of `node scripts/prove-daily-cap.mjs`, which runs the real reset script on a copy of an exhausted database and shows the counters unchanged and the gateway still refusing with "day cap exceeded".

The timer has `Persistent=false` on purpose: a missed midnight must not turn into a mid-day reset.

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

## Not verified

- Cloudflare's real-address behavior with this setup. The app takes the rightmost `X-Forwarded-For` entry and only from a loopback connection; `cloudflared` shares the app's network namespace so the connection is loopback, but whether the header it carries holds the visitor's address was not observed. The two-network test above is how you find out.
- Anything on the real host: Docker version, systemd timer firing, the host's arm64 build and run.
- The ledger carry against a database that a real app and worker have written to for days. It is tested on throwaway databases with receipts made through the Quest and analysis gateways, and in the cap proof with all four lanes.
- The 00:00 UTC reset on a real clock. Tests inject the clock; the container run used `--force` because it was mid-day.
- No outside party has tested this. It inherits the open items in `docs/SECURITY_WATCH.md` and `docs/THREAT_MODEL.md`.
