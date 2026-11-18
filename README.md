# See / Spec / Send

**A free, open-source way for the people at a company to get the annoying problems everyone already knows about actually fixed, with AI doing the building and the people who do the work deciding whether it helped.**

[![CI](https://github.com/stevenammer/see-spec-send/actions/workflows/ci.yml/badge.svg)](https://github.com/stevenammer/see-spec-send/actions/workflows/ci.yml) [![CodeQL](https://github.com/stevenammer/see-spec-send/actions/workflows/codeql.yml/badge.svg)](https://github.com/stevenammer/see-spec-send/actions/workflows/codeql.yml) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/stevenammer/see-spec-send/badge)](https://scorecard.dev/viewer/?uri=github.com/stevenammer/see-spec-send) [![Security policy](https://img.shields.io/badge/security-policy-blue)](SECURITY.md)

**Want to see it before you read about it?** [Try the demo](https://stevenammer.github.io/see-spec-send/). It runs in your browser, the people are made up, and nothing leaves your page. Click "Show me the rule being enforced" and watch it say no.

![Clicking "Show me the rule being enforced" in the demo: the people who wrote or approved the spec try to say it helps, and are refused](docs/screens/demo-refusal.gif)

## Why I built this

Everybody at work already knows the thing that's broken. The workaround has a name. Somebody has a spreadsheet for it. And nobody fixes it, because the people who feel it don't get to build anything, and the people who build things never feel it.

From where I sit, plenty of companies are being told to "use AI" and are paying outside firms to ask employees what's wrong with their workflows. Then the good ideas die somewhere between the complaint, the meeting, the budget and the red tape.

This is my attempt at skipping that. Start with the people who have the problem. Let AI help them fix it. Keep a record of what worked, so the next person with the same problem doesn't start from zero.

## What it looks like

Say Maya works in support, and she's tired of copying every refund into a spreadsheet by hand.

1. **See it.** Maya posts the problem in plain words and says what she already checked. Is there a setting for this? A tool the company already pays for? A free one? Plenty of problems end right here, with "oh, it already does that." An AI called Effort replies first, always labeled as AI, and the rest of the team can add to the thread.
2. **Spec it.** Maya writes down what the fix has to do ("show each refund once") and how everyone will know it worked ("nobody opens the spreadsheet anymore").
3. **Send it.** A leader who *didn't* write the spec, say Lena, reads it and decides. If she approves, she sets a budget. An AI agent builds a small version in a locked box, and the box's only way out is a counted, capped connection to the AI. The team tries it.

Then comes the part I care most about: **nothing counts as "it helped" until enough people who do the work say it helped.** Not Maya, who wrote the spec. Not Lena, who approved it. Other people, who actually tried it. If they don't, it gets shelved with a written reason, and the reason stays on the record.

That rule isn't a policy in a handbook. The code enforces it. There's no "done" button anywhere, and a leader can't override it. You can [watch the real server refuse](docs/WATCH_IT_REFUSE.md) the person who wrote the spec, the leader who approved it, and a made-up "done" event.

## What the AI can and can't do

It can draft, explain, and build small things inside the locked box. It **can't** approve anything, spend past the cap, or decide whether something helped. Every AI answer is labeled as AI. Spending is metered and capped by a gateway that holds the key, so nothing in the box ever sees it.

## Who this is for

- **Someone at a company with a problem everyone knows about.** You don't need to be technical to post one. That's the point.
- **A leader who wants to try AI from the bottom up** instead of buying something and hoping people use it.
- **Whoever has to review it before anyone's allowed to use it** (IT, security, legal). There's a lot here for you, lower on this page.

## How far along it is

Early, and I'm building it in public. It isn't ready to drop into a big company tomorrow, and I'd rather tell you that than have you find out.

**Works, and you can check it yourself:**

- The core loop above, in a real web app and in the demo.
- Over 800 automated tests on every push, plus walkthroughs in a real browser and an accessibility check.
- Effort and the "ask the organization" answers have had a first real-model test too ([docs/MODEL_EVAL.md](docs/MODEL_EVAL.md)). That test found the answer cap was cutting every thorough answer off, and it's fixed.
- Bring your own model and your own agent. The builder can be OpenCode, Claude Code or Codex, behind a gateway that meters and caps every call, and the models can be Claude, GPT, Gemini, Bedrock or local ([docs/AGENT_HARNESSES.md](docs/AGENT_HARNESSES.md), including what's proven and what isn't).
- The AI builder works on small tasks. On three made-up workplace tools, judged in a real browser, Claude Haiku 4.5 shipped 11 of 12 builds for about five cents each. The write-up is [docs/BUILDER_EVAL.md](docs/BUILDER_EVAL.md), including why that's thin evidence.
- Hostile text can't trick it into approving or spending. I test that with 60 nasty strings (fake instructions, look-alike letters, hidden scripts) through every place an AI reads text.
- People only see what their department lets them see.
- Sign in with the company's existing login (any standard OIDC provider).
- If the server dies, a live copy of the database that follows along about once a second can bring it back. In my drill it came back in under a second and lost the last couple of seconds of writes.

**Not done, and code alone won't finish it:**

- No outside security test. No SOC 2. No test with a real screen reader user.
- Not yet tested against a real Okta, Entra or Google login.
- No automatic failover and no Postgres version. A person decides when to switch to the copy. [The plan for Postgres](docs/POSTGRES_PLAN.md) is written down, and the dependency question is settled: SQLite stays the dependency-free default, and Postgres would be an optional extra.
- No Teams or Microsoft 365 integration yet. That's planned.
- Most of the tests use stand-in models, so the real-model testing is thin. Effort, the answers and the builder each had one first test with Claude Haiku 4.5 (above), and that's all. You plug in your own model, so check it on your own work.
- **No real pilot with real employees.** That's the one that matters most, and it's what I'd like to do next.

The complete, honest table is [docs/STATUS.md](docs/STATUS.md).

## If you're technical

**Run it yourself.** You need Node 22.19 or newer. There's nothing to install. This starts a server with a throwaway database:

```sh
export SSS_DB="$(mktemp -d)/sss.db"
node cli.js init --id leader
node cli.js serve --port 8787 --insecure-cookies
```

`init` prints a temporary leader password. Copy it, open http://127.0.0.1:8787/signin, sign in as `leader`, and pick a real password before you do anything else. `--insecure-cookies` is for local http only. Delete the temp folder and everything's gone.

**Check my work.**

```sh
npm test               # the whole suite
npm run check:mutants  # break controls on purpose to see if the tests notice (hours on a laptop; CI splits it up)
npm run check:public   # scans files and git history for secrets and private paths
npm run test:listen    # real server, short end-to-end
npm run test:container # needs Docker; uses a local mock model, never a real one
```

I break the controls on purpose (over 600 deliberate breaks so far) because a test that can't fail doesn't count. A weekly CI job runs them split into parallel pieces (about an hour in total), and you can start it any time from the Actions tab. So far I've run one piece of the full set and all of the newer set there. The first scheduled run is the next Sunday. The browser tests (`npm run test:e2e`, `test:vision`, `test:hostile-render` and friends) need Playwright and Chrome. Set `PLAYWRIGHT_DIR` to the folder that holds Playwright.

**Security and trust.** It has no runtime dependencies. CodeQL, a container scan (Trivy), a Dockerfile and workflow lint, and the OpenSSF Scorecard run in CI. Start with [SECURITY.md](SECURITY.md) (how to report a problem), then the [threat model](docs/THREAT_MODEL.md), [threats being watched right now](docs/SECURITY_WATCH.md), the [vendor questionnaire](docs/VENDOR_QUESTIONNAIRE.md), the [first AI-driven audit run and what it found](docs/AUDIT_2026-11-17.md), the [pilot guide](docs/PILOT_GUIDE.md) and the generated [table of every route and how it's authenticated](docs/ROUTE_TABLE.md). Failover, backups and what erasure does to a replica are in [docs/HA.md](docs/HA.md).

![The work feed at phone width](docs/screens/feed-390.png)

![An item in the Send stage with a playable try](docs/screens/item-trying-1280.png)

(Fictional data, from the real-browser test.)

**The long version of what's built** is [docs/WHAT_IS_BUILT.md](docs/WHAT_IS_BUILT.md). The [vision](docs/VISION.md), [roadmap](docs/ROADMAP.md) and [decisions](docs/DECISIONS.md) say where it's headed and why I chose what I chose.

## How I'm building it

I write the specs and decide what's safe to ship. AI agents write most of the code. Then I try to break what comes back, and I keep every attack that found a real bug as a permanent test. So far that's a money rounding bug, a reused retry key that silently dropped an event, a stale builder that could deliver under a newer approval, and a same-origin check that a lookalike address could fool. A second AI, set loose as a hostile reviewer, found four more: world-readable database files, a verifier that said "ok" to forged metadata, a lockout that let a stranger lock you out, and a rate limiter that never forgot.

The real-model tests were small and cheap: Claude Haiku 4.5 on Amazon Bedrock, a few dollars in total (the builder tests cost about $2.30), on made-up data. Nothing has run against real employee data, and none of the models you can plug in has been tested beyond that.

## Words used here

(The app has the same list on a page of its own, at `/words`.)

- **SEE, SPEC, SEND:** the three steps above. A SEE is the problem, a SPEC is what the fix must do, a SEND is the request to try it.
- **Effort:** the AI that replies first. It's always labeled, and it never decides anything.
- **Steward:** whoever's currently responsible for the SEE and SPEC. Usually the person who posted it.
- **Leader:** someone allowed to approve a try and set its budget. They can't approve their own spec.
- **Helps:** the only way an item counts as a win. Enough different people, who aren't the spec's author or its approver, say the current build helps.
- **Fork:** a new branch from an old SEE, SPEC or try when someone disagrees. A fork starts with no approval.

The working name for the bigger picture is E.F.F.O.R.T. for Organizations, and the name isn't final. Credits and licenses for what this builds on are in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).

## Contributing

Read-only for now. Issues and Discussions are open, and I'd love to hear what's wrong with the idea. I'm holding pull requests until the core settles, so nobody wastes effort on something that moves under them.

## License

Apache-2.0. Free for every organization.
