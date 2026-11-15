# See / Spec / Send

Status: reviewable SPEC drafting, source-linked organizational investigation, the current conversation demo and optional private mentoring now accompany workspace memory: post a SEE without Vision Quest, discuss it with Effort queued first, write a separate SPEC, send one frozen packet for a reasoned leader decision, fork, and adopt OP-only builder instructions. The browser walkthrough uses a labeled fixture. The optional container builder is verified with a local mock model.

Rules 2 verification (2026-11-14): unit, public-file and demo-parity checks run locally. The separate CI browser job runs the Vision and E2E journeys. See `docs/INVARIANTS.md` for the stale-state authorization chain. Effort is always shown first as an honest status or reply. Vision Quest is optional.

| Gate | Command | Commit | Date | Environment | Result |
| --- | --- | --- | --- | --- | --- |
| F3 release controls | 11 exact full-suite mutation gates | `4b48a83` | 2026-11-15 | Frozen trees, Node 22.23.4 | PASS, including deterministic backup retry |
| Hosted browser workflows | `test:vision`, `test:e2e` | `4b48a83` | 2026-11-15 | GitHub Actions Chrome | Both PASS; required by `fd0fad0` |
| F4 full suite | `npm test` | `d4ab97a` | 2026-11-15 | Node 22.23.4 | PASS, 405 tests, zero skips |
| F4 Docker acceptance | `npm run test:container` | `d4ab97a` | 2026-11-15 | Real Docker, local mock | PASS, 9 tests; no hosted vendor |
| F5 full suite | `npm test` | `87c3547` | 2026-11-15 | Node 22.23.4 | PASS, 414 tests, zero skips |
| FTS5 minimum runtime | F5 memory tests | `87c3547` | 2026-11-15 | Official Node 22.19 | PASS, 6 tests; Node 22.13 lacks FTS5 |
| F6 full suite | `npm test` | `0f64104` | 2026-11-15 | Node 22.23.4 | PASS, 423 tests, zero skips |
| F6 real browser and demo | `test:vision`, `test:e2e`, `test:demo-vision` | `0f64104` | 2026-11-15 | Chrome, including 390px | PASS; fixture provider |
| F7 full suite | `npm test` | `1464298` | 2026-11-15 | Node 22.23.4 | PASS, 427 tests, zero skips |
| F7 current browser journey | `npm run test:vision` | `1464298` | 2026-11-15 | Chrome, including 390px | PASS, structured draft review and OP publication |
| F4–F7 extended mutation release gates | Prefix-selected full-suite mutations | Pinned slice commits above | 2026-11-15 | Frozen trees | In progress; not a completed release claim |
| Hosted model/vendor | explicit opt-in only | Slice commits above | 2026-11-15 | Bounded provider | NOT RUN, no paid calls |


Everybody at work already knows the thing that's broken. The workaround has a name. Somebody has a spreadsheet for it. And nobody fixes it, because the people who feel it don't get to build anything, and the people who build things never feel it.

This is my attempt at a free, open-source way for any organization to fix that with AI, and to do it the right way:

1. **See it.** Find the problem everyone already knows about and nobody has fixed. Check first whether something you already have solves it (a setting, a tool you pay for, a free one). Plenty of problems end right there.
2. **Spec it.** Write down exactly what the fix has to do, and how we'll know it worked.
3. **Send it.** A leader sets a budget. An agent builds a small version. It goes in front of the people doing the work, and **nothing counts until they say it helps.**

That last rule isn't a policy in a handbook. The code enforces it. There's no "done" button anywhere. An item only reaches Helps when enough different people, who are neither the one who wrote the spec nor the one who approved it, confirm the current build helps. A leader can't override it. You can [watch the real server refuse](docs/WATCH_IT_REFUSE.md) the person who wrote the spec, the leader who approved it, and a made-up "done" event.

**Try the demo.** There's a small demo that runs in your browser, at https://stevenammer.github.io/see-spec-send/. The people are invented, there's no server, and nothing leaves your page. It runs a copy of the real state machine, so you can try to get around the rule and watch it refuse. It doesn't have sign-in, the database, or the password step-up. See [docs/DEMO.md](docs/DEMO.md).

Credits and licenses for what this builds on: [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).

## Where this actually is

I'm building this in public, and it's early. This is a checkpoint, not a release. The code is ahead of the docs: `docs/ADMIN.md` and a few others don't yet describe every new command. Everything below is what the tests show. The conversation journey has real-browser coverage with fixture providers. Real load and a real identity provider remain unverified. Here's the honest state:

- **The conversation journey (new, first pass).** One real browser session now walks the original idea end to end, with three or four people: someone posts a SEE in their own words (the Vision Quest is optional), Effort (the AI) always replies first and is labeled as AI, other people comment in threads, and only the poster decides what gets included, with credit to the commenter. SPEC IT! makes the spec its own post where Effort also replies first. SEND IT! freezes one spec and a decision packet. A different leader reads it and approves, returns, or records Not building with a written reason. Approval fixes a dollar cap, helper quorum, maximum build turns, and an expiry window. The worker stops expired work, and reviewed packets remain visible with every decision. An optional OP estimate is labeled as unverified; the six research categories say exactly which sources are not connected. A declined decision does not block another SEE. Anyone can fork a specific SEE, SPEC or try, including a terminal parent. A fork starts with only an unapproved draft and never inherits an approval. Lineage is verified and rebuilt from the event chains. Only comments the poster adopts reach the builder. You can tag @effort in any comment for a reply (ten a day per person, thirty per post), the SEE history shows what changed between versions with credit for each included comment, Effort's spec comment is a starting point and never a decision, and a leader can reassign the steward (never the original poster) only with the current steward's consent or after 14 days of inactivity, with a public note. If the poster revises the SEE after SEND, the running build is stopped, the old approval stays in the history, the delivered try is labeled superseded and can't collect Helps, and a new spec, SEND and leader approval are needed. Replies and spec inclusions are tied to the exact version they answer, the decision packet lists who was credited, and a fork keeps the reason it was made. Both Chrome journeys passed on the hosted runner at `4b48a83`; browser CI is required, including the current demo journey. This is checked in real Chrome (`npm run test:vision`) and by tests that try each refusal. **Honest limits:** the browser journey uses a fixture builder; the optional CLI container builder produces model-written static HTML and now receives adopted instructions, verified only with a local mock model; research starts disconnected and the packet says "nothing checked"; an operator can enable internal workspace research, while external sources remain disconnected; estimates are supplied by the OP and aren't independently verified; workspace search, contribution pages and optional participant-only mentoring are available; organizational investigation prepares a source-linked packet for your chosen AI and checks its pasted answer, while built-in analysis and automatic briefs remain unshipped; Vision Quest stays optional; the anonymous demo now has a current conversation panel alongside its labeled earlier manual example. Effort in the journey runs on the built-in fixture, not a live model.

- **Works and tested:**
  - **The core.** A small state machine that decides what can happen to an item, and a local store that records every step in a tamper-evident chain. Money is exact, builder events are tied to the approval they were built under, and each event hashes the authority it was accepted under. Registry edits cannot rewrite history. Exports include the registry, so importing is an administrator action for files you exported yourself.
  - **The manual path with a web UI.** A person can post a checked problem, write a spec, have a leader who isn't the current steward approve it with a password step-up, deliver one safe playable try, and reach Helps only when other people say it helps. Neither the steward nor the author of a spec can approve it.
  - **Vision Quest, no-model mode.** The default is a portable prompt file for an organization's existing chat tool plus a strict memo import. Every imported result is model output, never authority. The anonymous demo includes a fictional no-model Quest using the same core. See [docs/VISION_QUEST.md](docs/VISION_QUEST.md).
  - **Sign-in and a small HTTP API.** Invites, passwords, sessions, CSRF protection, rate limits for login, invite redemption, and step-up, and a leader step-up before approval. Member writes are limited to 60 a minute, events to 16 KB and 200 state events plus 1,000 comments per item, and lists come in pages of 50. People can be disabled, promoted, demoted and reset from the command line, invites can be listed and revoked, and admin commands write a chained audit trail. The command line is the only admin surface. See [docs/ADMIN.md](docs/ADMIN.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), which also lists what isn't covered.
  - **The local worker, fake builder, and container builder.** An approved spec can reach a small static try through one durable run. `worker` uses the fake builder by default. `worker --builder container --gateway-socket PATH` builds with a model inside a locked Docker container (no network, read-only, non-root, dropped capabilities, PID, CPU and memory limits, a deadline that also runs inside the container so a dead worker can't leave one running). The container's only way out is a Unix socket to the metering gateway (`gateway serve --socket PATH`), which holds the provider key, enforces the caps and writes the ledger. Verified in `npm run test:container` with real Docker, the real command line, and a local mock model server. **Not verified:** a real hosted model vendor, which needs a separate owner go. The worker needs the Docker socket, which is root on the host; read [docs/ADAPTER.md](docs/ADAPTER.md) before turning it on.
  - **Kept work records.** Comments pin the spec or artifact version they address, evidence keeps its source and honesty label, members can add check-ins, and a leader-only stewardship handoff cannot reopen a past steward's vote.
  - **Optional fixture drafting.** A preflight exposes the exact packet and worst-case estimate. It cannot send without explicit approval, and every result is labeled model output. See [docs/DRAFTING.md](docs/DRAFTING.md).
  - **Signed integrations.** Organization tools can report a source-labeled Seen problem with a five-minute HMAC receipt. Outbound event receipts use a durable signed outbox and leave private text out by default. Webhook secrets are stored encrypted under a key file kept outside the database and backups, and can be rotated with an overlap window, disabled, and removed. The replay check uses only signed material. See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).
  - **Watchdog and operations.** The watchdog checks worker heartbeats, worker-observed wall-clock caps, and unrecoverable outbox rows. It stops through the existing emergency latch and records an event. Compose, a systemd unit, and backup commands are included in [docs/QUICKSTART_ORG.md](docs/QUICKSTART_ORG.md). Backups verify the copy, a restore drill checks the result, and backups can be encrypted. A privacy erasure runs from the command line with a required reason and is audited. The server can sit behind a TLS front end on loopback (`--trusted-proxy`, HSTS, Secure cookies) or serve HTTPS directly; the Compose file with its TLS front end has not been run with real Docker and a real certificate yet. Outbound calls to providers and webhooks dial the exact address that passed the address check (a loopback rebinding proof passes), and the providers file must be owner-only. Tries are served only to a sandboxed frame, and model-built tries get no script permission. A dead outbox row raises an alert and does not stop the install. Databases from earlier releases upgrade in place with a backup first, and a database from a newer release is refused.

- **Built but not usable yet:**
  - **Quest model draft.** Off unless `serve` is started with `--enable-quest-model`. When on, each call goes through the gateway and ledger, is limited per person and per day, and stops on the kill latch. This is tested in process only. I have not run it against a live provider since these changes.
  - **Identity-provider seam.** Test-only OIDC flow pieces and an injected verifier seam exist. No built-in verifier, provider configuration, or real identity-provider run exists, so identity-provider sign-in is not shipped.
  - **Postgres seam.** `PostgresStore` and a SQLite-backed behavioral fake exist. There is no PostgreSQL driver, connection path, migration, or real PostgreSQL test. See / Spec / Send is SQLite only.

I'm treating local tests as claims. `npm test` runs them, and `npm run check:mutants` deliberately breaks individual controls and checks that the tests notice. Those checks are not currently run by CI. If a test can't fail, I don't count it.

## What it looks like

![The work feed at phone width](docs/screens/feed-390.png)

![An item in the Send stage with a playable try](docs/screens/item-trying-1280.png)

These earlier manual-workflow screenshots use fictional data and come from the real-browser test. The current conversation demo has its own phone-width browser check.

## Run it yourself

You need Node 22.19 or newer (with SQLite FTS5). There's nothing to install. For a separate local fixture app, run `npm run preview` and use the generated access file it prints. It preserves this preview's private database. To start a server with a throwaway database:

```sh
export SSS_DB="$(mktemp -d)/sss.db"
node cli.js init --id leader
node cli.js serve --port 8787 --insecure-cookies
```

`init` prints a temporary leader password. Copy it, sign in, and use the password-change screen to choose a permanent password before working. `serve` keeps running, so use a second terminal for anything else. Then open http://127.0.0.1:8787/signin and sign in as `leader`. `--insecure-cookies` is for local http only. The database is in a temp folder, and deleting that folder removes everything.

To see the main rule refused without clicking through it, run `node scripts/watch-it-refuse.mjs`. The output is in [docs/WATCH_IT_REFUSE.md](docs/WATCH_IT_REFUSE.md).

## Words used here

- **Steward:** the person currently responsible for curating the SEE and SPEC. The person who originally posted it keeps originator credit after a permitted handoff.
- **Approver:** the leader recorded on the `approved` event. For the current conversation journey, the originator, past stewards, and authors cannot decide their own send.
- **Step-up:** typing your password again, right before approving. It's good for five minutes and works once.
- **Quorum:** how many different people must say "it helps". The approver sets it, and it's frozen with the approval.
- **Artifact:** the one playable HTML try that gets delivered. A "helps" only counts for the current artifact.

## Try it

These are the checks. There are no dependencies to install for the first four.

```sh
npm test
npm run check:mutants
npm run check:public
npm run check:demo
npm run test:listen
npm run test:container
```

`test:listen` starts a real server on a local port and runs a short end-to-end check. `check:public` is a guard that scans the files and the git history for secrets, private paths, personal emails and backup files before anything gets published.

`test:container` is separate from `npm test`. It needs the local Docker daemon and
the exact digest in `worker/builder-image.digest`, so it can't run in restricted
sandboxes. It uses a local mock gateway and never calls an external API.

`npm run test:e2e` is separate and isn't part of the no-dependency path. It drives a real browser, so it needs an existing Playwright install (set `PLAYWRIGHT_DIR` to the folder that holds it) and Chrome (set `CHROME_PATH` if it isn't at `/usr/bin/google-chrome`).

## How I'm building it

I write the specs and decide what's safe to ship. AI agents write most of the code. Then I try to break what comes back, and I keep the attacks that found real bugs as permanent tests. So far, attacks found a money rounding bug, a reused retry key that silently dropped an event, a stale builder that could deliver under a newer approval, and a same-origin check that a lookalike address could fool. A second AI, set loose as a hostile reviewer, found four more: world-readable database files, a verifier that said "ok" to forged metadata, a lockout that let a stranger lock you out, and a rate limiter that never forgot. All of them are fixed, and each fix has a test that fails without it.

## Contributing

Read-only for now. Issues and Discussions are open, and I'd love to hear what's wrong with the idea. I'm holding pull requests until the core settles, so nobody wastes effort on something that moves under them.

## License

Apache-2.0. Free for every organization.
