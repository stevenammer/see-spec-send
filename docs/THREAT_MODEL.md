# Threat model, slice 2

| Attack | Control | Proof |
| --- | --- | --- |
| Stolen database | Password, invite, session, and API tokens are digests | `auth rejects plaintext storage` |
| Reused invite | Digest, expiry, transactional single use | `parallel invite redemption` |
| Password guessing | Per-IP and per-account buckets plus exponential lockout | `login rate limit and lockout` |
| Account discovery | Same generic login reply and scrypt work | `no user enumeration` |
| Session theft | HttpOnly, Secure, Strict cookie and rotation | `cookie attributes and session rotation` |
| Cross-site write | Origin or Referer and session CSRF nonce | `csrf cases` |
| Privilege spoofing | Server assigns person, core resolves authority | `client cannot send role or actor` |
| Registry edits rewrite history | Accepted events hash their authority snapshot | `authority snapshots preserve history` |
| Self-certification after a handoff | Past spec authors, stewards, and approvers cannot help | `spec authors and past stewards never become helpers` |
| Redaction corrupts replay | Erasure stores a replayable tombstone and receipt | `redacted critical bodies replay` |
| Approval replay | Five-minute, server-side, single-use step-up | `step-up required, stale, single use` |
| Parser abuse | JSON size limit and unsafe-key rejection | `oversized and malformed bodies` |

Not covered yet: multi-factor authenticators, email delivery, distributed rate limits,
external database checkpoints, recovery drills, encrypted backups, a browser UI, and
protection from a host administrator who can alter the database and application.
Also not built: a trusted-proxy mode (behind a reverse proxy, per-IP limits see the proxy's
address, so run it directly or add that mode first), and cutting off an oversized request
body mid-stream (it is refused, but the connection is not dropped early).

One bug found while reviewing this slice: the same-origin check compared a string prefix, so
`https://localhost.evil.test` passed for an origin of `https://localhost`. It now compares
parsed origins, with a regression test and two mutants (`Origin check`, `Origin prefix match`).

## Second review (Nov 9)

A separate hostile review (a different AI, in its own sandbox, with a repro script for every claim) found four real issues. I re-ran every repro myself, then fixed them with tests and mutants:

| Finding | Fix | Proof |
| --- | --- | --- |
| Database and backups were world-readable (mode 0644) | Created owner-only (0600); backup refuses an existing target | `the database and its backups are private to the owner` |
| `verify` said "ok" for forged submission metadata and skipped orphaned events | The idempotency key is bound into the submission hash; `verify` lists every item with events or a cache row and checks the cache against a full replay | `verify catches forged submission metadata, orphaned events and cache drift` |
| Five failed logins from five other addresses locked the owner out | Lockout is per address with exponential backoff; account-wide guessing hits a high ceiling that expires on its own | two lockout tests |
| The in-memory rate limiter grew without bound | Idle buckets are pruned and the map has a hard cap | `the rate limiter forgets idle identities` |

I also found one the review missed: the first admin's one-time password came from `Math.random()`. It now uses `crypto.randomBytes`.

Still true, on purpose: any signed-in person can read any item. The product is built around an open feed, so there is no per-item read control yet. If you need confidential items, that has to be designed in first. A host administrator who can edit both the database and the code can still recompute the hash chain; the chain detects accidents and partial tampering, not a determined insider with full access.

## Slice 3, manual web path

Covered: sign-in, CSRF, and same-origin checks on each new write; role checks for approval and
delivery; step-up approval; a distinct-helper quorum; stale artifact refusal in the machine; 256 KB
artifact limit; escaped item text; strict page CSP; and artifact CSP plus an opaque-origin iframe.
The proof is `manual web path is authorized, escaped, sandboxed, and has strict pages`, alongside
the existing `csrf cases` and `step-up required, stale, single use` tests.

Proved in a real browser (`npm run test:e2e`, run outside any sandbox): four people sign in through the
real screens and drive one item to Helps and another to Shelved. The steward and the approver get no vote
button. Text like `<img onerror=...>` posted as a problem is shown as text and never runs, in the item
page and in the feed. Inside the try, reading the cookie and reaching the parent page both throw a
SecurityError, because the frame is sandboxed without `allow-same-origin`.

Not covered: the viewer is an opaque-origin iframe, not a separate hostname. There is no stored-XSS fuzz
corpus yet. Only one browser engine has been run.

What the browser test caught that the in-process tests missed: the web form did not send the CSRF token,
so posting a problem always failed in a real browser; the history showed a token hash instead of the
person who delivered the try; and the steward and approver could not even see the try.

## Continuation verification

New events bind their authority snapshot into the event hash. Old-format events retain
those old hashes; migration captures the then-current registry once. It cannot reconstruct
an actor's original historical authority or retrofit that proof into an old hash. Migration
refreshes the derived context cache atomically. Reopening after a later demotion preserves
the captured legacy snapshot. Hand-built old-schema tests cover both behaviors.

Redaction now seals the replacement body's checksum into the erasure receipt. An erased
flag without that receipt fails verification, as does a changed structural tombstone.
Only known machine fields survive; unknown metadata is discarded, and known free-text
fields become placeholders. The event identities, actor IDs and structural references
remain. This is redaction of an event body, not removal of a person's entire identity.

The independent continuation reproduced four additional failures before fixing them:
legacy snapshots changed on reopen, old caches no longer matched replay, an unreceipted
erased flag bypassed verification, and unknown personal metadata survived erasure.
The full suite passes52 tests. The four-person browser walkthrough passes after the fixes.
Eleven changed-control mutations are independently killed: the six peer-review controls,
two legacy migration controls, two redaction controls and the helper-vote view.
The past-author handoff view has a permanent regression in addition to the core refusal.
The writer stress test still uses120 real processes, with at most4 in flight to avoid
loading120 runtimes into a small machine. The full49-mutation campaign was not rerun
in this continuation.
