# Slice 10 notes

OIDC needs a reviewed issuer/discovery policy, redirect URI registration, state,
nonce, PKCE, token validation and rotation, account-linking/revocation behavior,
and tests against a local identity-provider fixture. It must not turn an IdP claim
into a mutable item role.

Postgres needs an explicit demonstrated multi-node requirement, migration and
rollback plan, transaction/isolation mapping for event append and gateway
reservation, backup/restore drills, least-privilege roles, and a concurrency
suite against the real server. SQLite remains the implemented store.
