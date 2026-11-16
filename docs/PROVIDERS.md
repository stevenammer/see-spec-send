# Bring your own provider

See / Spec / Send doesn't keep provider keys in its database. It reads a plain
`sss.providers.json` file, in the same directory as the database (`SSS_DB`).
Set `SSS_PROVIDERS_FILE` to use another absolute or relative location. The file
contains provider names, hosts, prices, and references to credentials. It must
not contain a key itself. The CLI writes it with owner-only file permissions.
The file, and any `apiKeyFile` a provider names, is refused when it is group or
world writable or not owned by the user running the service.

Every enabled provider has an explicit table in integer micro-dollars per million
tokens. Zero is valid and is how an organization declares an entirely local
model. There is no unpriced path. Metering reserves the input bound and requested
maximum output before a call, then settles reported usage. If usage is absent or
invalid, the reservation remains held. Prices are estimates, not invoices.

```json
{
  "providers": [{
    "name": "local",
    "kind": "openai",
    "enabled": true,
    "url": "http://127.0.0.1:18084/v1/chat/completions",
    "hosts": ["127.0.0.1"],
    "allowPrivate": true,
    "model": "your-installed-local-model",
    "price": { "inputMicrosPerMillion": 0, "outputMicrosPerMillion": 0 }
  }],
  "defaults": { "your-org-id": "local" }
}
```

This example uses a local server and an explicitly zero-priced local model. Remote
providers require reviewed prices; a free tier is not assumed. Create the JSON
entry in a protected file, then add it. This deliberately keeps
the secret out of shell history too.

```sh
node cli.js provider add --file ./local.provider.json --default-org your-org-id
node cli.js provider default --org your-org-id --name local
node cli.js provider list
node cli.js provider test --name local --max-output 1
node cli.js provider disable --name local
node cli.js provider remove --name local
node cli.js gateway serve-provider --org your-org-id --port 8081
```

`provider test` is the only configuration command that makes a provider call. It makes exactly
one short call after printing its worst-case reservation. It doesn't test during
add, list, disable, or remove. A default is command-line configuration, never a
browser setting. Callers must reject a provider that isn't enabled, including a
stale default.

The container builder resolves the organization's enabled CLI default to its
reviewed model name. Start `gateway serve-provider --org your-org-id` with that
same default. With no enabled default, the builder keeps using the local fixture,
so a new installation cannot spend by accident. The gateway host, not the
container, resolves the provider URL and credential.

The container worker can use a configured provider through a private Unix-socket
gateway. Initialize the persisted policy with `gateway fixture-enable`, then use
`gateway policy set --file policy.json` for a reviewed operator policy. The word
fixture in the initialization command does not choose a provider or authorize paid
calls. The worker uses its fake builder until explicitly started with
`--builder container --gateway-socket PATH`. See [ADMIN.md](ADMIN.md) for the
complete process commands and Docker boundary. Slow or failed calls retain
charged holds; `gateway holds list` and `holds release` support explicit operator
reconciliation with a reason. They never automatically refund unknown work.

## Admin live-smoke checklist

Configured provider calls can charge the organization. Configuration itself makes no call; the commands below must use the reviewed provider, limits and data permissions.

1. Put the key in its protected environment variable or owner-readable key file.
2. Add the reviewed provider entry and set its organization default.
3. Initialize the gateway policy, then set reviewed caps and timeouts with `gateway policy set --file policy.json`.
4. A deliberate `provider test --name NAME --max-output 1` makes one direct diagnostic call. It prints a price estimate; it is not a production ledger reservation.
5. Start the private-socket gateway and container worker as described in ADMIN.md. Start `serve --enable-effort --effort-provider NAME` only when that provider may receive the work discussion.

The builder sends a fixed system instruction plus `must`, `how_we_know`,
`out_of_scope`, OP-adopted instruction strings and the current approved source/audience
scope. It does not send raw discussion, commenter identities, browser data or secrets.
It accepts one HTML document only. Markdown fences and surrounding commentary
are stripped deterministically. A failed validation gets one separately metered
repair request, then the run fails without another retry.

## Recipes

OpenAI, Azure OpenAI, Ollama, vLLM, LiteLLM, Groq, OpenRouter, and most company
gateways use `"kind": "openai"`. Use their chat-completions URL and list only
the exact DNS host in `hosts`. Azure's deployment URL is allowed as its `url`.
Ollama or another local server needs `"allowPrivate": true`; use its exact
loopback hostname in `hosts` and its local model may legally be priced at zero.

Anthropic uses `"kind": "anthropic"` and the Messages endpoint. Gemini uses
`"kind": "gemini"` and a generateContent endpoint. Both use the same fields
above. Put the key's environment-variable name in `apiKeyEnv`, or an absolute
owner-readable key file in `apiKeyFile`, never both.

For a custom HTTPS service, use `"kind": "webhook"`. It receives this JSON:

```json
{"system":"...","messages":[{"role":"user","content":"..."}],"maxOutputTokens":64,"model":"your-model"}
```

It must return:

```json
{"text":"untrusted model text","usage":{"inputTokens":12,"outputTokens":8}}
```

`"kind": "command"` runs an organization-owned executable from a configured
argument array. It receives the same request JSON on standard input and writes
exactly that response JSON on standard output. It has a wall-clock timeout and
output cap. It receives no database credential, worker credential, browser data,
or provider key unless the organization itself gives its process one.

## Amazon Bedrock

Amazon Bedrock uses `"kind": "bedrock"`. Its file has no URL, host list, or
credential field. At call time it reads `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` from the service
environment. Nova Lite's reviewed list-price table is 60000 input and 240000
output micro-dollars per million tokens:

```json
{
  "name": "nova-lite",
  "kind": "bedrock",
  "enabled": true,
  "region": "us-east-1",
  "modelId": "amazon.nova-lite-v1:0",
  "price": { "inputMicrosPerMillion": 60000, "outputMicrosPerMillion": 240000 }
}
```

Add it with `node cli.js provider add --file nova-lite.provider.json`. The file
cannot contain AWS credentials. `serve --analysis-provider nova-lite` is an
explicit opt-in for organizational analysis. Without that flag, analysis stays
sources-only and makes no model call. The configured gateway policy must be
enabled and keeps its existing daily cap. `reanalysis run --verify
--analysis-provider nova-lite` enables the same metered advisory check for that
manual run. It can only hold a match or add uncertainty to its annex.

## Network boundary

HTTPS is required. Plain HTTP is only available to an explicitly private-enabled
local provider. URLs can't carry credentials or fragments. The only accepted
query is Azure's single non-secret `api-version` parameter. Each
request checks the configured host allowlist, resolves it, and refuses private,
link-local, loopback, and metadata-style addresses unless `allowPrivate` is
true. Redirects are refused. Requests and responses are capped and timed out.
Errors redact keyed credentials and Bearer/Basic token shapes. This is a bounded
redactor, not permission to put arbitrary secrets into prompts or command output.

Model output is untrusted text. It is labeled as model output and can never
approve work, alter the ledger, change a spec, or act as instructions.

Vision Quest model routes are off unless `serve` includes `--enable-quest-model`.
The configured service uses `QuestGateway`, shared ledger caps, per-person limits
and the kill latch. This metered service is the HTTP path; the lower-level
`draftQuestModel` helper is not exposed as an unmetered route. Effort uses its own
metered service with first-reply and mention allowances; structured SPEC drafts
remain suggestions for the steward to edit and publish.

Organizational investigation currently prepares a reviewed packet for a person's
chosen AI and checks a pasted answer. It does not call a configured provider.

The offline tests use only loopback mock servers and local commands. They prove
wire parsing and the controls described here. They do not make live vendor calls,
verify a vendor's current API behavior, certify a production network deployment, or certify a provider bill.
