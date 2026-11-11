# Slice 10 notes

Slice 10 adds optional identity and storage seams. The default remains the existing
SQLite `Store` and password/session plus item-scoped token authentication. Nothing
selects OIDC or Postgres automatically.

## OIDC login

`app/oidc.js` implements an authorization-code flow with S256 PKCE, 256-bit
single-use state, a separate nonce, and a ten-minute in-memory pending-login
window. The HTTP start route also creates a fresh random browser binder in a
pre-authentication `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Only its hash is
kept with the pending state; the callback requires the matching cookie, consumes
the state before any exchange, and clears the binder cookie after either success
or refusal. This binds a callback to the browser that initiated it and fails
closed after a missing or mismatched cookie. `OidcLogin` takes explicit provider
configuration:

```js
new OidcLogin({
  issuer: 'https://issuer.example',
  authorizationEndpoint: 'https://issuer.example/authorize',
  clientId: 'see-spec-send',
  redirectUri: 'https://app.example/api/oidc/callback',
  exchange: async ({ code, clientId, redirectUri, codeVerifier }) => ({ id_token }),
  verifyIdToken: async idToken => verifiedClaims,
})
```

The caller-owned `verifyIdToken` is the signature and JWKS-validation boundary.
It must reject unsigned tokens, enforce key selection and algorithm policy, and
return only claims from a verified ID token. This module additionally checks the
exact configured issuer, audience, authorized party for multi-audience tokens,
nonce, subject, expiration, issued-at time, and a one-hour maximum token life.
Configuration only accepts clean HTTPS URLs. Discovery is deliberately not fetched
at request time, so an operator reviews and pins the issuer endpoints first.

The HTTP routes appear only when `new Auth(store, { oidc })` receives an adapter:
`GET /api/oidc/start` and `GET /api/oidc/callback`. The callback creates the same
HttpOnly, Secure, Strict session cookie as password login. A provider subject maps
to a deterministic opaque local person ID. Claims never match or overwrite a local
password account, never set leader, and cannot satisfy password step-up. Promote a
mapped person only through the normal administrator process. Pending state is
intentionally process-local, so restart during sign-in fails closed and requires a
fresh login.

`FakeOidcProvider` is an in-process test fake. It validates PKCE and single-use
codes but is not a real token-signature implementation.

## Postgres seam

`core/postgres-store.js` provides `PostgresStore` behind the existing synchronous
`Store` interface. A production constructor requires a reviewed, injected
compatibility driver with `open(database)` returning `exec`, `prepare`, and `close`.
That driver is responsible for connection pooling, TLS, parameter binding, schema
migrations, SQL-dialect translation, and serializable append transactions. The app
does not accept a connection string by itself and does not open a database network
connection implicitly.

`FakePostgresStore` is an in-process behavioral fake. `test/store-contract.test.mjs`
runs the same named store-contract suite against the default SQLite store and that
fake, without a service or network. It establishes API behavior only. It does not
prove PostgreSQL locking, isolation, SQL translation, failover, backups, or recovery.
Before production selection, add a real PostgreSQL driver and run the full store,
worker, gateway, migration, concurrent-writer, backup, and restore suites against a
throwaway server using a least-privilege application role.

## Conservative choices recorded

| Choice | Reason |
| --- | --- |
| SQLite and existing auth stay default | No implicit infrastructure or identity change. |
| Explicit endpoints, no live discovery | Prevents unreviewed issuer metadata from becoming runtime authority. |
| Opaque ID, no email matching | Prevents account takeover through mutable claims. |
| OIDC cannot use password step-up | A password-only approval proof must not be silently weakened. |
| Hashed, one-time OIDC browser binder | A callback URL alone cannot establish an IdP session in a different browser, and a pending-entry disclosure does not reveal the cookie value. |
| `reported_by` equals event actor | A reported claim can only name the authenticated event author until a separately attested reporter workflow exists. |
| Injected Postgres compatibility driver | The synchronous Store API must not pretend an async network driver is transaction-safe. |
| In-process fakes only in tests | Tests stay offline and do not claim real IdP or database coverage. |
