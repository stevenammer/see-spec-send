# Does the builder actually work?

I wasn't sure, so I tested it. Short answer: **yes, with the right model and the right instructions, and not before.** This page says what I ran, what came back, and how far to trust it. It's a first pass, and I say below why it's still thin.

## What I tested

The builder is an AI coding agent (OpenCode) that runs in a locked container with no network. Its only way out is the metered gateway that holds the key and counts the money. It's given an approved spec and writes a small web page. Then the host checks the page against a strict allowlist and throws it away if it breaks a rule.

I wrote three synthetic workplace tasks, each with a spec a leader might approve:

1. **Refunds.** Paste a refund list, click Clean up, get each order once with a total and a list of bad lines.
2. **Swap board.** Post shift swaps, keep them after a reload, remove one.
3. **Triage.** Five yes/no questions that end in "Escalate to a leader" or "Handle it yourself."

A page is judged in a real Chrome browser by what it **does** (fill it in, click it, reload it), not by how it looks. A build "ships" only if the host accepts it **and** every check passes. The judge proves itself first: for each task a hand-written good page must pass every check and a deliberately broken page must fail (`npm run test:builder-judge`).

## Results (Nov 17, 2026)

Two batches. The first ran every model once on each task. The second ran Claude Haiku 4.5 and Claude Sonnet 4.5 three more times on each task, so each of those two has about a dozen runs.

**Claude models, all valid runs (a "valid" run is one where the model was actually reachable):**

| Model | Runs | Shipped | Average cost per build | Where it failed |
| --- | --- | --- | --- | --- |
| Claude Haiku 4.5 | 12 | **11** | about $0.05 | once, on the swap board |
| Claude Sonnet 4.5 | 10 (2 more lost to an AWS error) | **8** | about $0.16 | twice, both on the swap board |

Both models' failures were the same bug on the same task: after a reload, the swap board came back oldest-first instead of newest-first. Haiku also got that right in 5 of 6 swap runs. On the other two tasks neither model failed: refunds and triage shipped every time they ran.

**Two of Sonnet's runs never started.** AWS answered "Access denied. This model is marked by provider as Legacy and you have not been actively using the model in the last 30 days" on some calls and not others. Those two runs are left out above, and I'm saying so instead of counting them as the model's failures or quietly dropping them.

**First batch, one run each (all four models):**

| Model | Refunds | Swap board | Triage | Ships |
| --- | --- | --- | --- | --- |
| Claude Haiku 4.5 | ships | ships | ships | 3 of 3 |
| Claude Sonnet 4.5 | ships | built, board came back oldest-first | ships | 2 of 3 |
| Amazon Nova Pro | ships | refused by the host | correct, but refused by the host | 1 of 3 |
| Amazon Nova Lite | wrong logic | refused by the host | ships | 1 of 3 |

Total spend across every run, including the failed attempts: about $2.30 of a $10 cap. Costs are the gateway's own meter at list prices.

## What it means

- **The AI part works.** The cheap model (Haiku) shipped 11 of 12 builds at about five cents each, usually in under half a minute.
- **A bigger model wasn't better here.** Sonnet cost three times as much and shipped 8 of 10. The sample is small enough that I wouldn't call that a ranking, but it gives no reason to pay for the bigger model on tasks like these.
- **The weak spot is persistence details.** Both models' only failures were how the board is ordered after a reload. That's the kind of thing a person testing the tool would catch quickly, and a spec that says it plainly doesn't always get it.
- **The instructions mattered more than the model.** My first prompt never told the agent which HTML the host allows or how to create files. With it, Nova Lite went from 0 usable builds in 3 to 1 in 3. One Nova Lite run looped 31 times and never wrote a file, because it kept using a tool that can't create files. The prompt now lists the allowed elements and attributes and says how to write files.
- **Correct builds still get refused.** Nova Pro's two refusals were correct pages that used `<form>`, even though the prompt said not to. The host doesn't allow `<form>`, `<fieldset>` or `<legend>`, and models reach for them by habit. Whether to allow the harmless ones is a security decision I haven't made for you.
- **The one-shot builder can't make tools at all.** It refuses any script, so it only makes static pages. Anything interactive has to come through this agent path.
- **Free tiers can't run it.** Gemini's free tier rate-limited within a few runs, and Groq's 8,000 tokens a minute is below what one agent call sends. This test needed a paid lane.

## How far to trust this

Not far, yet:

- **Small samples.** Haiku and Sonnet have about a dozen runs each, Nova Pro and Nova Lite have three. Model output varies run to run, so these are rough rates, not rankings.
- **Three synthetic tasks,** written by me. Real problems are messier.
- **One agent (OpenCode),** with one prompt. I haven't tested any other harness.
- **My judge was wrong once.** It demanded an amount in a list row that the spec never asked for, and it blamed the wrong step on the swap board. I fixed both, re-judged every saved build for free, and the table above uses the corrected judge. Treat the judge as a tool with its own bugs.
- **No human looked at these pages for usability.** The judge checks behavior, not whether a person would like it.

## Run it yourself

```sh
docker build -t sss-opencode:0 worker/opencode        # then record the image id in worker/opencode-image.digest
export PLAYWRIGHT_DIR=/path/to/node_modules
npm run test:builder-judge                           # proves the judge, no model
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  npm run eval:builder -- --provider bedrock --model claude-haiku --budget-usd 1
```

Results print one JSON line per run (calls, tokens, cost, what the host decided, what the judge found). `--rejudge FILE` re-judges saved builds without calling a model. `--debug-agent` writes the agent's own log for diagnosis.
