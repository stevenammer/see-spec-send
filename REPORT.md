# Slice 12 report

## Assumptions

- An organization supplies reviewed prices in integer micro-dollars per million tokens. Zero means a local model with no provider charge.
- The existing gateway's capability, approval, cap, reservation, settlement, and kill rules remain the authority boundary. A configured provider is an adapter behind that boundary, never an authority source.
- A local model is intentional only when its provider entry says `allowPrivate: true`.
- The current fake builder stays model-free and can't choose a provider. A future real builder must resolve an enabled name through the same configuration boundary.

## Open questions

- An organization needs to decide who owns price review and how it updates prices.
- A production deployment needs a DNS connection-pinning strategy or a restricted egress proxy to close the post-resolution rebinding gap called out in PROVIDERS.md.

## Controls and proof

| Control | Test that fails without it |
| --- | --- |
| Provider must be priced | `provider priced required` mutant, `test/provider.test.mjs` |
| Host allowlist and private-address gate | `provider host allowlist` mutant, `test/provider.test.mjs` |
| Redirect refusal | `provider redirect refusal` mutant, `test/provider.test.mjs` |
| Response-size cap | `provider response cap` mutant, `test/provider.test.mjs` |
| HTTP status, malformed JSON, missing usage, slow response, and mid-stream drop | `test/provider.test.mjs` local mock cases |
| Private address and URL-credential refusal | `test/provider.test.mjs` checked-URL cases |
| Local command timeout and output cap | `test/provider.test.mjs` command adapter conformance |
| Secret-shaped text redaction | `test/provider.test.mjs` and `provider/safe-http.js` |
| Existing reserve, cap, settle, kill and idempotency rules | Existing gateway mutants and `test/gateway.test.mjs` |
| Explicit draft consent | `draft explicit approval` mutant and drafting tests |

## Outcome check

The repository now has a narrow provider contract, built-in wire adapters, a secret-reference-only config and CLI administration path, price declarations, safety checks, conformance checks, offline adapter tests, and copy-paste provider documentation. No live vendor call was made.
