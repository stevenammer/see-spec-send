# Slice 14 report

## Outcome check

- Vision Quest keeps no-model mode as the default. Portable prompts and strict memo import use the same deterministic Quest schema. The opt-in provider seam preflights a reviewed provider packet and requires explicit approval. Model text is labeled as draft output and cannot change authority or state.
- The anonymous demo has a fictional, no-model Quest memo derived from the shared generated core. It makes no network calls.
- `watchdog` checks stale heartbeats, wall-clock run age, and old dead or sending outbox rows. It calls the existing kill latch and writes `watchdog.stop`. Offline tests cover stale heartbeat and outbox stop paths.
- `compose.yaml`, the systemd unit, quickstart, and backup and restore drill are present. The drill has an offline test.
- README now separates built and offline-proven seams from production identity, Postgres, and live provider work that remains unexercised.

## Assumptions

- A portable chat tool is untrusted. Its pasted memo must exactly equal the local deterministic memo, so it can assist drafting but cannot alter a decision.
- A dead or long-lived sending outbox row past the configured threshold is unrecoverable enough to fail closed. An operator investigates, then explicitly clears the latch.
- The watchdog's defaults are 15 seconds for heartbeat and 15 minutes for runs and outbox. Operators can override them on the CLI.
- Compose is a local or small-host quickstart, not a production container security profile. The optional container builder keeps its existing separate gateway setup.

## Open questions

- Do organizations want a less strict model-draft import that accepts a separately reviewed, schema-validated prose memo? That would need a human acceptance step and a new immutable record, not automatic overwrite.
- What heartbeat and outbox limits fit the first real deployment's worker cadence and destination SLAs?
- Which production identity provider and Postgres operational model should be exercised first?

## Verification

- `npm run check:demo` passed.
- `npm run check:public` passed.
- Focused worker, Vision Quest, watchdog, backup, restore, and demo drift tests passed.
- Full `npm test` reached existing local HTTP gateway tests that cannot bind `127.0.0.1` in this restricted sandbox (`EPERM`). No external call was attempted. The same restriction prevents a complete mutation-suite run here.
