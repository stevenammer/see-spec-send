# Does the AI part work? (chat, analysis and reanalysis)

The builder has its own page ([BUILDER_EVAL.md](BUILDER_EVAL.md)). This one covers the other places a model reads and writes: Effort (the AI that replies to people), ask-the-organization (a source-linked answer from the record) and the reanalysis check (does a new result really bear on an old decision). Same rule as before: say what was run, what came back, and how far to trust it. Nov 17, 2026.

## What I ran

Four models through the Bedrock adapter directly: Claude Haiku 4.5, Claude Sonnet 4.5, Amazon Nova Pro and Amazon Nova Lite. Sonnet 4.5 was unusable by the time I tried (AWS answered "marked as Legacy, not used in the last 30 days"), so it's missing below.

- **Effort replies.** Six made-up situations with checkable expectations (a vague post, a post whose fix may already exist, an instruction hidden in a post, a request to approve a budget, a question that needs arithmetic from the post, a question the post can't answer). Two replies each, at the production cap of 256 output tokens. `npm run` script: `scripts/eval-effort.mjs`. The checks are rules, so they miss tone and usefulness. I also read the replies.
- **Ask-the-organization.** Five real questions and three prohibited ones (rank people, guess motives) against six made-up work records, through the real analysis pipeline. `scripts/eval-model-lanes.mjs`.
- **Reanalysis check.** Twelve labeled pairs (six that bear on an old decision, six decoys). Same script.

## Results

**Effort replies, 30 checks each:**

| Model | Before I changed the prompt | After |
| --- | --- | --- |
| Claude Haiku 4.5 | 24 | **29** |
| Amazon Nova Pro | 21 | 26 |
| Amazon Nova Lite | 27 | 27 |

Reading the replies matters more than the scores. After the change Haiku sounds like a person: it says "I can't approve work, set budgets, or make decisions, people decide those things," says "the post doesn't say which team" instead of inventing one, and asks one concrete question. Nova Pro still invents a plan when a post is silent. Nova Lite is fine on short cases but sometimes narrates its instructions.

**Ask-the-organization, five questions (the product refuses a model answer that isn't valid, complete, cited JSON and shows sources only instead):**

| Model | First run, 2,048-token limit | 1,024 tokens (the old production cap), with a compactness line I later reverted | 4,096 tokens | Grounded findings at 4,096 |
| --- | --- | --- | --- | --- |
| Claude Haiku 4.5 | **1 of 5** | **1 of 5** | **5 of 5** | 21 of 25 |
| Amazon Nova Pro | 4 of 5 | 1 of 5 | 4 of 5 | 4 of 11 |
| Amazon Nova Lite | 4 of 5 | 5 of 5 | 5 of 5 | 7 of 8 |

Haiku was cut off at both smaller limits. The Nova models move around between conditions, which is a sign the sample is small, not that one setting is better for them.

All three models refused all three prohibited questions without a model call, because that's the code, not the model.

**Reanalysis check, 12 labeled pairs:** every model kept every real match (none wrongly held). Agreement with my labels was Nova Pro 10 of 12, Claude Haiku 8 to 9, Nova Lite 7 to 8, varying a little between runs. The gap is small and the sample is tiny.

## What it means

- **Claude Haiku 4.5 is the best single choice** for Effort and ask-the-organization, and the builder ([BUILDER_EVAL.md](BUILDER_EVAL.md)). It's also thorough: an answer to a question costs about 1.5 cents.
- **The caps decide whether a good model works at all.** Production capped an analysis answer at 1,024 tokens. Haiku writes 2,000 to 3,000, so every answer was cut off mid-sentence and refused, and the feature silently fell back to sources only. (The Nova models' results at the old cap look fine, but they write less and cite less.) I raised the ceiling to 4,096 (an operator's own policy and the per-person daily dollar cap still bound it).
- **A prompt line couldn't fix it.** I asked for a compact answer. Haiku ignored it and Nova Pro got worse, so I reverted it. The evidence pointed at the cap, not the wording.
- **The Effort prompt was the real lever there,** as the builder prompt was for the builder. It never told the model to write plain text, stay short, avoid internal jargon, say when the post doesn't say, or send people to check for an existing fix first. It does now, and every existing test on that prompt still passes.
- **Sonnet 4.5 on this AWS account isn't dependable.** It's marked Legacy. Pick a current model before depending on it.

## How far to trust this

Not far, yet:

- Tiny samples: twelve Effort replies per model, five ask-the-organization questions, twelve reanalysis pairs, one run each.
- The Effort checks are rules I wrote. They missed some good replies and passed some mediocre ones, which is why I read them.
- "Grounded" is a rough word-overlap test against the cited source, not a person checking the claim.
- All made-up data, one provider (Bedrock), one day.
- I haven't tested what free-tier models can do for these jobs, or any other agent harness.

## Run it yourself

```sh
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node scripts/eval-effort.mjs --model claude-haiku --samples 2 --show
EVAL_B_MAX=4096 EVAL_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0 EVAL_PRICE_IN=1 EVAL_PRICE_OUT=5 node scripts/eval-model-lanes.mjs
```
