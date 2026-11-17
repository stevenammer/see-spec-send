# Plan: a real Postgres store

Status: **a plan, not built.** Today it's SQLite only. `core/postgres-store.js` is a 27-line seam with no driver behind it. This page says what a real port takes, in the order I'd do it, so anyone reviewing it can argue with the plan before the work starts.

## Why bother

A company's database team already runs Postgres, already backs it up, and already knows how to fail it over. SQLite plus a live copy ([HA.md](HA.md)) is honest and works, but a person has to decide when to switch, and the first thing a security reviewer asks is "can we run this on our database?"

## What the code looks like today (measured Nov 17, 2026)

- 516 direct SQL calls across 38 files (not counting tests). 156 are in `core/store.js`, 58 in `app/auth.js`, 35 in `gateway/ledger.js`.
- Every one of them is **synchronous**, because Node's built-in SQLite is. Postgres is network I/O, so every caller has to become `async`.
- 59 test files reach into `store.db` directly.
- About 84 places use SQLite-only features (`INSERT OR IGNORE`, `PRAGMA`, `rowid`, date and JSON helpers).
- Search is SQLite FTS5 (`core/memory.js`). Postgres needs a different full-text design.
- 38 places manage transactions by hand. The tamper-evident event chain depends on appends being strictly ordered per item.

## Decision made (Nov 17, 2026)

The repo says "no runtime dependencies," and that's true today. Talking to Postgres needs a driver (`pg`). **The decision: the default install stays dependency-free and SQLite-only. The Postgres build installs `pg` as an optional extra in its own image.** The README line becomes "no runtime dependencies unless you choose Postgres" at the point the Postgres build ships, and not before. The only other route would be writing a Postgres wire-protocol client in this repo, which I'm not doing for a security-sensitive project.

## Slices, in order

1. **One async door.**
   - **1a, done:** `core/db.js` with `get`, `all`, `run`, `exec` and `tx`, all promises, tested and mutation-checked. Transactions get their own scoped handle, and calls made on the door while one is open wait for it, so another request's statements can't land inside it. I first tried to *detect* that after the fact and my own test showed the detection was unreliable, so it now prevents it. One caveat stays until the Store itself is converted (slice 4): code that still uses the connection directly isn't held back, so a transaction's work shouldn't wait on real I/O yet.
   - **1b, done:** `app/integrations.js` (26 SQL calls) now goes through the door. I picked it first because it's self-contained: three source callers (the HTTP inbound route, the watchdog and the CLI) and six test files. Making it async made `watchdog` async too, and its callers await it. The pattern for converting a module: take the door with `sqlFor(store.db)`, make every method that touches the database `async`, run multi-statement work inside `tx`, and `await` every caller. Things I'd flag from doing it: the Store's own `appendInTransaction` is still synchronous and is called inside the transaction on the same connection (that converts in slice 4), and finding the key file's path uses a SQLite-only PRAGMA, left on the raw connection and marked as such.
   - **The ledger is not a leaf.** `gateway/ledger.js` is called from inside the synchronous transactions of `gateway/effort.js`, `quest.js` and `analysis.js`, so converting it forces that whole family (plus `worker/container.js`, `opencode.js`, `cli.js` and about 25 test files) to convert in one change. It's the hardest cluster in the codebase, so it comes after the leaf modules, as its own slice.
2. **Leaf modules.** `core/mentoring.js`, `knowledge/corrections.js`, `notifications/digest.js`, then the rest, one at a time. Each is its own commit with the full suite green. The gateway family (ledger, effort, quest, analysis, http, container and opencode adapters) is its own slice at the end of this group.
3. **Auth and sessions.** `app/auth.js` (58 calls). Login, step-up and invite redemption are security-critical, so this gets its own mutation checks before and after.
4. **The store core.** `core/store.js` (156 calls) and the event append path. Add the ordering guarantee Postgres needs (a per-item advisory lock inside the transaction) so the chain can't fork.
5. **HTTP and CLI.** Await everything in `app/http.js` and `cli.js`.
6. **The Postgres dialect.** The SQL differences, then full-text search on `tsvector`, then migrations on Postgres, then backup and restore (`pg_dump` / managed snapshots) and what erasure means for them.
7. **Prove it.** Run the whole test suite against **both** backends in CI, with a Postgres service container. The existing `test/store-contract.test.mjs` becomes a real-Postgres contract test. Then a failover drill on a Postgres replica.

## When it's done

It's done when the same tests pass on both backends in CI, not when it compiles. Until slice 7 passes, the README keeps saying "SQLite only," and the default never changes under anyone.

## What it won't be

Postgres doesn't give you high availability by itself. That comes from how your operator runs it (a managed service, or Patroni, or similar). This work makes it *possible* to use the high availability your database team already trusts. It doesn't build any.

## Rough size

Slices 1 and 2 are a day or two each. Slice 4 is the risky one and I'd budget most of a week for it, including the mutation checks. I'm guessing at all of this. Slice 1 will tell us how wrong the guess is.
