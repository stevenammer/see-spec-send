# See it. Spec it. Send it.

Everybody at work already knows the thing that's broken. The workaround has a name. Somebody has a spreadsheet for it. And nobody fixes it, because the people who feel it don't get to build anything, and the people who build things never feel it.

This is my attempt at a free, open-source way for any organization to fix that with AI, and to do it the right way:

1. **See it.** Find the problem everyone already knows about and nobody has fixed. Check first whether something you already have solves it (a setting, a tool you pay for, a free one). Plenty of problems end right there.
2. **Spec it.** Write down exactly what the fix has to do, and how we'll know it worked.
3. **Send it.** A leader sets a budget. An agent builds a small version. It goes in front of the people doing the work, and **nothing counts until they say it helps.**

That last rule isn't a policy in a handbook. The code enforces it. There's no "done" button anywhere. An item only reaches Helps when enough different people, who are neither the one who wrote the spec nor the one who approved it, confirm the current build helps. A leader can't override it.

## Where this actually is

I'm building this in public, and it's early. Here's the honest state:

- **Works and tested:**
  - **The core.** A small state machine that decides what can happen to an item, and a local store that records every step in a tamper-evident chain. Money is exact, builder events are tied to the approval they were built under, and roles come from a registry instead of from whatever an event claims to be.
  - **The manual path with a web UI.** A person can post a checked problem, write a spec, have a different leader approve it with a password step-up, deliver one safe playable try, and reach Helps only when other people say it helps.
  - **Sign-in and a small HTTP API.** Invites, passwords, sessions, CSRF protection, rate limits, and a leader step-up before anything gets approved. The command line is the only admin surface. See [docs/ADMIN.md](docs/ADMIN.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), which also lists what's not covered.
- **Not built yet:** the model layer, builder adapters, the cost gateway, Vision Quest, and kept modules. Don't try to run an organization on this yet.

I'm treating tests as claims. `npm test` runs them, and `npm run check:mutants` deliberately breaks the code in 39 different ways and checks that the tests notice. If a test can't fail, I don't count it.

## What it looks like

![The work feed at phone width](docs/screens/feed-390.png)

![An item in the Send stage with a playable try](docs/screens/item-trying-1280.png)

These screenshots come from the real-browser test.

## Try it

You need Node 22 or newer. There are no dependencies to install.

```sh
npm test
npm run check:mutants
npm run check:public
npm run test:listen
npm run test:e2e
```

`test:listen` starts a real server on a local port and runs a short end-to-end check. `check:public` is a guard that scans the files and the git history for secrets, private paths, personal emails and backup files before anything gets published.

## How I'm building it

I write the specs and decide what's safe to ship. AI agents write most of the code. Then I try to break what comes back, and I keep the attacks that found real bugs as permanent tests. So far, attacks found a money rounding bug, a reused retry key that silently dropped an event, a stale builder that could deliver under a newer approval, and a same-origin check that a lookalike address could fool. A second AI, set loose as a hostile reviewer, found four more: world-readable database files, a verifier that said "ok" to forged metadata, a lockout that let a stranger lock you out, and a rate limiter that never forgot. All of them are fixed, and each fix has a test that fails without it.

## Contributing

Read-only for now. Issues and Discussions are open, and I'd love to hear what's wrong with the idea. I'm holding pull requests until the core settles, so nobody wastes effort on something that moves under them.

## License

Apache-2.0. Free for every organization.
