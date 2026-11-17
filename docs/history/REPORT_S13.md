# Slice 13 report

## Assumptions

- An organization supplies reviewed prices in integer micro-dollars per million tokens. Zero means a local model with no provider charge.
- The existing gateway's capability, approval, cap, reservation, settlement, and kill rules remain the authority boundary. A configured provider is an adapter behind that boundary, never an authority source.
- A local model is intentional only when its provider entry says `allowPrivate: true`.
- The current fake builder stays model-free and can't choose a provider. A future real builder must resolve an enabled name through the same configuration boundary.
- A Seen integration receipt is separate from a human Checked event, so no inbound system becomes a steward.
- Source and destination secrets live only in the owner-only SQLite database and are accepted only by CLI arguments. The CLI never lists or logs them.
- A scheduler runs `integration outbox deliver`. This slice doesn't add a background daemon.

## Open questions

- An organization needs to decide who owns price review and how it updates prices.
- A production deployment needs a DNS connection-pinning strategy or a restricted egress proxy to close the post-resolution rebinding gap called out in PROVIDERS.md.
- A future deployment may need a dedicated secret vault instead of the owner-only local database.
- A future deployment may want an explicit public base URL for outbound links. This slice uses a relative link.

## Controls and proof

| Control | Test that fails without it |
| --- | --- |
| Provider must be priced | `provider priced required` mutant, `test/provider.test.mjs` |
| Host allowlist and private-address gate | `provider host allowlist` mutant, `test/provider.test.mjs` |
| Redirect refusal | `provider redirect refusal` mutant, `test/provider.test.mjs` |
| Response-size cap | `provider response cap` mutant, `test/provider.test.mjs` |
| Integration signature, time window, replay and schema | Slice 13 mutants and `test/slice13.test.mjs` |
| Inbound has no workflow authority | `integration source authority` mutant and `test/slice13.test.mjs` |
| Outbox is durable and private by default | `integration outbox transaction` mutant and `test/slice13.test.mjs` |

## Outcome check

Inbound is signed, time-bounded, replay-protected, rate-limited, and strictly shaped. It can only create a source-labeled Seen receipt. Outbound events are signed, durable with the event, retried, and dead-lettered. Private text stays out by default. No integration path grants workflow authority.
