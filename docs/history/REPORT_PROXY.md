# Metered chat proxy report

Implemented `POST /v1/chat/completions` as an OpenAI-compatible, per-run
capability route. It accepts non-streaming and SSE chat requests, preserves
tools and legacy functions fields, and uses the existing receipt ledger for
reserve, pre-dispatch authorization, dispatch, settlement, idempotency, and
summary accounting. Proxy receipts store the existing receipt ID/call ID, run,
reviewed model/rate, token usage, micros, state, and request hash. They retain
no prompt, completion, tool-call, or SSE body.

The focused proxy test file has 6 subtests: 5 passed and 1 is skipped in this
sandbox. The skipped test is `OpenAI chat-completions endpoint emits normal JSON
and SSE`; binding `127.0.0.1` fails with `EPERM: operation not permitted`.
Its in-process counterparts passed: tool-call round trip and pre-dispatch hold,
streaming settlement, cap refusal on call N+1, missing-usage/restart
idempotency, and revoked/forged capability behavior.

`npm test` could not complete in this sandbox: after 12 passing top-level test
files, `test/gateway.test.mjs` failed because its real localhost HTTP listener
also receives the same `EPERM`. The runner stops there, so no full-suite-green
claim is made. No provider key, network request, or paid model call was used.

## Behavior decision recorded

Completed proxy calls cannot replay their response after a lost client
connection, because storing response bodies is prohibited. The same run and
idempotency key returns the settled receipt as HTTP 202 and never re-dispatches.
This is intentionally documented in `docs/GATEWAY.md` rather than guessed as a
body-retention exception.
