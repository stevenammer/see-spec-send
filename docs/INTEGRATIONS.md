# Integrations

Integrations can report a problem and receive a small event receipt. They cannot approve, name a steward, vote, say a try helps, or edit an existing item.

Create secrets at the terminal. The CLI never prints them again.

```sh
node cli.js integration source add --name slack-intake --secret 'at-least-16-random-characters'
node cli.js integration destination add --name ops-hook --url https://hooks.example.com/sss --secret 'another-random-secret'
```

`integration source list`, `integration destination list`, and `integration outbox list` show configuration and delivery state without secrets. Run `node cli.js integration outbox deliver` from your scheduler. Failed receipts retry with exponential backoff five times, then show as `dead`.

## Inbound

POST JSON to `/api/integrations/inbound/SOURCE`. Sign the exact UTF-8 bytes and send:

```text
content-type: application/json
x-sss-timestamp: milliseconds since Unix epoch
x-sss-signature: sha256=hex HMAC-SHA256(secret, timestamp + "." + raw body)
idempotency-key: one unique retry key, up to 160 characters
```

The timestamp must be within five minutes. A signed retry is refused. Bodies are capped at 16 KiB and each source has a default 30 requests per minute. Only this schema is accepted. Inbound text is never treated as HTML.

```json
{"problem":"The handoff queue duplicates tickets.","source_label":"Slack workflow: #ops","honesty_label":"reported"}
```

`honesty_label` is `observed`, `reported`, or `documented`. An inbound receipt stays in the Seen stage. A signed-in person must check it before it moves forward.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature.replace(/^sha256=/, '')))) throw Error('bad signature');
```

**Slack workflow:** use a webhook step or tiny internal relay that stores and uses the signing secret. **Teams flow:** use an Azure Function or another internal signing step before its HTTP action. **Generic script:** serialize once, sign those same bytes, and retry only with the same idempotency key.

## Outbound

Each accepted event makes a durable outbox row in the same database transaction. Destinations must be HTTPS. `--allow-loopback` permits local HTTP only for an offline test receiver. Redirects are refused and DNS targets use the provider URL checks against private-address SSRF.

Outbound uses the same timestamp and `sha256=` HMAC headers. Its default body is:

```json
{"item_id":"...","stage":"CHECKED","event_type":"checked","link":"/items/..."}
```

No problem text leaves by default. An administrator can opt one destination in with `--include-text` when its receiver is permitted to have it. The link is relative, so the receiver does not learn a deployment origin from the event.
