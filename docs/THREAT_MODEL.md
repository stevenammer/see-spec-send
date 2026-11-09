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
