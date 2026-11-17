# Plugging in your own agent and model

Short version: **yes.** An organization can run Claude Code, Codex or OpenCode as the builder, and can point the AI parts at whichever frontier provider it already pays for. This page says how, what's proven and what isn't. Nov 17, 2026.

## The idea

An agent builder runs in a locked container: no network except one Unix socket to the **metered gateway**, no provider key, a read-only root, dropped capabilities, one writable folder. The gateway holds the key, enforces the caps, and writes the ledger. Each agent speaks its own protocol, so the gateway has one translation per protocol, and every one of them goes through the same reserve, dispatch and settle path. None adds a way to spend money.

| Agent | Speaks | Gateway endpoint | Builder flag | Proven live |
| --- | --- | --- | --- | --- |
| OpenCode | OpenAI chat completions | `/v1/chat/completions` | `--builder opencode` | 9 of 9 (Haiku) |
| Claude Code (Anthropic) | Anthropic Messages | `/v1/messages` | `--builder claude-code` | 9 of 9 (Haiku) |
| Codex (OpenAI) | OpenAI Responses | `/v1/responses` | `--builder codex` | 9 of 9 on the fixed host; 8 of 9 before the fix below (Haiku) |

Same three made-up tasks, same judge, same model behind the gateway (Claude Haiku 4.5 on Bedrock), judged in a real browser. Average cost per build: OpenCode about 4.5 cents, Claude Code about 4.8 cents (always 4 calls, about 12 seconds), Codex about 5.7 cents (about 5 calls, about 21 seconds, because it checks its own work). That's a tie on quality in this sample. It's a small sample: the three tasks are mine, and each agent has about nine runs.

## Claude Code as the builder

Claude Code is Anthropic's coding agent. It speaks Anthropic's Messages API. The metered gateway used to speak only OpenAI's chat format, so Claude Code couldn't connect to it. It can now: the gateway has a `/v1/messages` endpoint that translates Anthropic's format (system prompts, tool use, tool results, streaming) into the chat request it already meters, and back. Every call is reserved, capped and settled on the same ledger as any other call. It adds no new way to spend money and holds no provider key.

```sh
# 1. The gateway, with the provider you configured (see PROVIDERS.md). The agent only ever sees this socket.
node cli.js gateway serve --socket /srv/sss/gw/gateway.sock --name claude
# 2. The worker, with the Claude Code builder
node cli.js worker --builder claude-code --gateway-socket /srv/sss/gw/gateway.sock
```

Build the image once (it installs Claude Code at a pinned version from npm, under Anthropic's own terms; this repo doesn't redistribute it) and record its id:

```sh
docker build -t sss-claudecode:0 worker/claudecode
docker image inspect sss-claudecode:0 --format '{{.Id}}' > worker/claudecode-image.digest
```

What the container is: no network except the gateway socket, no provider key (the only credential is a short-lived capability bound to this run), a read-only root, dropped capabilities, one writable folder. Claude Code is allowed to read and write files there and nothing else: no shell, no web, no sub-agents. It gets the same build rules as the OpenCode profile (the allowed HTML, how to create files), and the host validates the result and gives it the same single repair pass if it's refused.

### What it measured

On the three made-up tasks in [BUILDER_EVAL.md](BUILDER_EVAL.md), with Claude Haiku 4.5 on Bedrock behind the gateway: **9 of 9 builds shipped** (accepted by the host and correct in a real browser), every run took exactly 4 model calls and about 12 seconds, and each cost about 4.8 cents by the gateway's own meter. OpenCode with the same model shipped 9 of 9 at about 4.5 cents. Tied on this sample.

### What the Anthropic endpoint supports, and refuses

Supported: text, custom tool definitions, tool_use and tool_result blocks, system prompts, streaming, and a token-count estimate (`/v1/messages/count_tokens`, an unmetered byte-based estimate). Sampling and bookkeeping fields (temperature, top_p, metadata, thinking, betas and similar) are accepted and dropped.

Refused, plainly, with an Anthropic-shaped error: images and documents, and server-side tools (web search, code execution, computer use), because the gateway can't meter or contain them. An unknown request field is refused too, so nothing slips through unreviewed. A budget refusal comes back as a `billing_error` (HTTP 402), so an agent stops instead of retrying forever.

Claude Code adds a system-role entry to the message list when it doesn't recognize a model name (a custom label is normal in a company gateway). The gateway folds those into one leading system prompt.

## Codex as the builder

Codex is OpenAI's coding agent. This version (0.167) speaks only OpenAI's newer Responses API, not chat completions, so the gateway has a `/v1/responses` endpoint that translates it: instructions and developer messages, function tools, function calls and their outputs, and Codex's streaming events. Codex always offers its model a few tools the gateway can't contain (web search, a sub-agent namespace, freeform tools). The gateway does **not** pass those on, so the model is never offered them and can't call them. Stateful features (`previous_response_id`, conversations, background mode) and images are refused with a plain error, because the gateway keeps no conversation state.

```sh
node cli.js gateway serve --socket /srv/sss/gw/gateway.sock --name openai
node cli.js worker --builder codex --gateway-socket /srv/sss/gw/gateway.sock
docker build -t sss-codex:0 worker/codex && docker image inspect sss-codex:0 --format '{{.Id}}' > worker/codex-image.digest
```

Codex's own sandbox is turned off inside the container, on purpose: it needs privileges the container doesn't have, and the container (no network, read-only root, dropped capabilities, one writable folder, no key) is the sandbox. The entrypoint says so. Codex writes files with its shell, which is why its prompt names no file tool.

What the first run found: one swap-board build (7 of 7 checks correct) was thrown away because Codex wrote `href="./style.css"` and the validator wanted `style.css`. The repair pass fired, but the reason ("must name a file you wrote") was too vague for the agent to understand, so it started over and made the same mistake. Two fixes: a leading `./` on a sibling file is now accepted (it's the same file; `../`, `/`, and URLs are still refused), and the reason now states the real rule. After the fix, the swap board shipped 3 of 3.

The Codex CLI is pinned in the Dockerfile and runs under OpenAI's own terms; this repo doesn't redistribute it. Because Codex talks to the gateway, an organization with an OpenAI key (or Azure OpenAI) uses the `openai` provider kind behind it: the gateway translates Responses to chat completions, which OpenAI and Azure still serve.

## Frontier models for everything else

The text jobs (Effort's replies, ask-the-organization, the reanalysis check) call a provider you name in `sss.providers.json` ([PROVIDERS.md](PROVIDERS.md)). Which kinds work for which job:

| Provider kind | Text jobs | Agent builders (OpenCode, Claude Code) | Notes |
| --- | --- | --- | --- |
| `anthropic` (Claude on Anthropic's API) | yes | **yes, new** | Tested against a stand-in for Anthropic's API, not the live one (see below) |
| `bedrock` (Claude, Nova and others on AWS) | yes | yes | The path I proved live |
| `openai` (any OpenAI-compatible endpoint: OpenAI, Azure OpenAI, Gemini's compatible endpoint, Groq, a local server) | yes | yes | Free tiers rate-limit too hard for an agent |
| `gemini` (Google's native API) | yes | no | Use Gemini's OpenAI-compatible endpoint with `openai` for an agent |
| `command`, `webhook` | yes | no | Text only |

Every provider has an explicit price table, so spend is always capped and metered.

## What's proven and what isn't

- **Proven live:** Claude Code (2.1.326) and Codex (0.167.0) as builders, each in the locked container, through its own endpoint, to Claude Haiku 4.5 on Bedrock, about nine runs each on three tasks. The real Claude Code CLI was also run directly against the gateway.
- **Tested but not live:** the `anthropic` provider (the direction that talks to Anthropic's own API) is tested against a local stand-in that checks the headers and request format, plus round trips through my own translators. I haven't run it against api.anthropic.com because I have no Anthropic key here. Treat the first real run as a test.
- **Not tested:** Codex or OpenCode with an OpenAI model behind the gateway (I only ran them against Claude on Bedrock), and the newest frontier tier (the latest Claude, GPT or Gemini models). I'd expect them to do better, but I haven't measured it. Better models write longer answers, and the output caps matter (see [MODEL_EVAL.md](MODEL_EVAL.md)).
- **Small samples,** made-up tasks, one agent version, one day.
- **Claude Code is Anthropic's product.** An organization uses it under its own agreement with Anthropic, and the version is pinned in the Dockerfile. Upgrading it is a deliberate change with a re-test.
