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
    "name": "openai",
    "kind": "openai",
    "enabled": true,
    "url": "https://api.openai.com/v1/chat/completions",
    "hosts": ["api.openai.com"],
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "your-reviewed-model",
    "price": { "inputMicrosPerMillion": 0, "outputMicrosPerMillion": 0 }
  }],
  "defaults": { "your-org-id": "openai" }
}
```

Create the JSON entry in a protected file, then add it. This deliberately keeps
the secret out of shell history too.

```sh
node cli.js provider add --file ./openai.provider.json --default-org your-org-id
node cli.js provider default --org your-org-id --name openai
node cli.js provider list
node cli.js provider test --name openai --max-output 1
node cli.js provider disable --name openai
node cli.js provider remove --name openai
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

`gateway serve-provider` is built but not usable as a production path. There is
no CLI command to configure an operator policy: `fixture-enable` is the only
policy-setting command. The worker ignores providers and always uses the fake
adapter, so an administrator cannot start a provider-backed builder through the
product. Slow or failed calls can also leave holds that permanently exhaust the
fixed concurrency limit. Do not use this route for an organization provider.

## Admin live-smoke checklist

This is the only intentional live-provider path. It can charge the organization.

1. Put the key in its protected environment variable or owner-readable key file.
2. Add the reviewed provider entry and set its organization default.
3. Stop here. The required operator-policy command and provider-backed worker do not exist yet.

The builder sends a fixed system instruction plus exactly `must`, `how_we_know`,
and `out_of_scope`. It does not send comments, people, browser data, or secrets.
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

## Network boundary

HTTPS is required. Plain HTTP is only available to an explicitly private-enabled
local provider. URLs can't carry credentials or fragments. The only accepted
query is Azure's single non-secret `api-version` parameter. Each
request checks the configured host allowlist, resolves it, and refuses private,
link-local, loopback, and metadata-style addresses unless `allowPrivate` is
true. Redirects are refused. Requests and responses are capped and timed out.
Errors attempt to redact credential-shaped text, but the current redactor leaves a
token following `Bearer` visible. Do not treat command output or errors as secret-safe.

Model output is untrusted text. It is labeled as model output and can never
approve work, alter the ledger, change a spec, or act as instructions.

Vision Quest's model routes do not use this provider boundary. They call a provider
directly, skip the gateway and ledger, accept caller-supplied `approved: true`, and
are not behind an explicit serve-time opt-in. They are built but not usable yet;
use no-model Quest instead.

The offline tests use only loopback mock servers and local commands. They prove
wire parsing and the controls described here. They do not make live vendor calls,
verify a vendor's current API behavior, prove DNS-rebinding resistance after the
initial lookup, or certify a provider bill.
