# Does the builder actually work?

I wasn't sure, so I tested it. Short answer: **yes, with the right model and the right instructions, and not before.** This page says what I ran, what came back, and how far to trust it. It's a first pass, one run per cell, and I'll say below why that's thin.

## What I tested

The builder is an AI coding agent (OpenCode) that runs in a locked container with no network. Its only way out is the metered gateway that holds the key and counts the money. It's given an approved spec and writes a small web page. Then the host checks the page against a strict allowlist and throws it away if it breaks a rule.

I wrote three synthetic workplace tasks, each with a spec a leader might approve:

1. **Refunds.** Paste a refund list, click Clean up, get each order once with a total and a list of bad lines.
2. **Swap board.** Post shift swaps, keep them after a reload, remove one.
3. **Triage.** Five yes/no questions that end in "Escalate to a leader" or "Handle it yourself."

A page is judged in a real Chrome browser by what it **does** (fill it in, click it, reload it), not by how it looks. A build "ships" only if the host accepts it **and** every check passes. The judge proves itself first: for each task a hand-written good page must pass every check and a deliberately broken page must fail (`npm run test:builder-judge`).

## Results (Nov 17, 2026, one run per cell)

| Model | Refunds | Swap board | Triage | Ships | Cost for all three |
| --- | --- | --- | --- | --- | --- |
| Claude Haiku 4.5 | ships | ships | ships | **3 of 3** | $0.17 |
| Claude Sonnet 4.5 | ships | built, but the board comes back oldest-first after a reload | ships | 2 of 3 | $0.23 |
| Amazon Nova Pro | ships | refused by the host | correct, but refused by the host | 1 of 3 | $0.05 |
| Amazon Nova Lite | wrong logic | refused by the host | ships | 1 of 3 | $0.004 |

Total spend: about 48 cents of a $10 cap. Costs are the gateway's own meter at list prices.

## What it means

- **The AI part works.** A small, cheap model (Haiku) built all three tools correctly, for about six cents each, in under half a minute.
- **A bigger model wasn't better here.** Sonnet cost more and had one real bug (it saved the swap board in the wrong order). One run each isn't enough to rank them, and I won't pretend it is.
- **The instructions mattered more than the model.** My first prompt never told the agent which HTML the host allows or how to create files. With it, Nova Lite went from 0 usable builds in 3 to 1 in 3. One run looped 31 times and never wrote a file, because it kept using a tool that can't create files. The prompt now lists the allowed elements and attributes and says how to write files.
- **Correct builds still get refused.** Nova Pro's two refusals were correct pages that used `<form>`, even though the prompt said not to. The host doesn't allow `<form>`, `<fieldset>` or `<legend>`, and models reach for them by habit. Whether to allow the harmless ones is a security decision I haven't made for you.
- **The one-shot builder can't make tools at all.** It refuses any script, so it only makes static pages. Anything interactive has to come through this agent path.
- **Free tiers can't run it.** Gemini's free tier rate-limited within a few runs, and Groq's 8,000 tokens a minute is below what one agent call sends. This test needed a paid lane.

## How far to trust this

Not far, yet:

- **One run per cell.** Model output varies run to run. Three tasks times four models is twelve data points. It shows what's possible, not a ranking.
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
