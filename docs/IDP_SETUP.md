# Connecting an identity provider

This is a checklist, not a promise. Sign-in has been tested in a real browser against one certified independent OIDC implementation. It has **not** been run against Okta, Microsoft Entra or Google tenants. Do this in a test tenant first, and check each provider's console wording against its current documentation, because those screens change.

## What the app needs from any provider

- An OIDC "web" application using the authorization code flow with a client secret (`client_secret_post` or `client_secret_basic`).
- Redirect URI exactly `https://YOUR-HOST/api/oidc/callback`.
- Scopes `openid` and `email`.
- ID tokens signed RS256 or ES256 with keys published at the provider's JWKS address.
- For **approvals**: the ID token must carry an `auth_time` claim, and the provider must honor `prompt=login` and `max_age=0`. If it does not, approving work is refused. That is the safe failure. Keep password sign-in on for the people who approve until you have proven this works.
- For an **email domain rule** (`allowedEmailDomains`): a verified `email` claim inside the ID token itself.

## Check your setup before anyone signs in

```sh
export SSS_OIDC_CLIENT_SECRET='...'      # the name must match clientSecretEnv in the file
node cli.js oidc check --config oidc.json
```

It fetches the provider's discovery document and signing keys (no sign-in) and prints `ok`, `warn` or `fail` lines: whether PKCE S256 is advertised, whether `prompt=login` and `auth_time` are advertised, how many usable keys there are, and the email-claim caveat. It exits non-zero only on a real blocker. It cannot prove a real sign-in works.

Then prove it with a person: sign in once, then try to approve something in a test item. Until you have done that, treat approvals through single sign-on as unproven.

## Okta (developer tenant)

1. Create an OIDC web app integration. Grant type: authorization code. Sign-in redirect URI as above.
2. Note the client ID and secret. The issuer is your Okta domain (or custom authorization server) with no trailing slash. Put it in `oidc.json` as `issuer`, and its host in `hosts`.
3. Assign the app to a test group only.
4. Okta puts `email` in the ID token for the `email` scope; confirm `email_verified` is true for your users before using `allowedEmailDomains`.
5. Run `oidc check`, then sign in, then try an approval.

## Microsoft Entra ID

1. App registration, platform "Web", redirect URI as above, add a client secret.
2. Issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0`. Set `tenantId` in `oidc.json` to pin the tenant.
3. **Use `tenantId`, not `allowedEmailDomains`.** Entra ID tokens usually have no verified-email claim, and a domain rule with no email is refused on purpose.
4. Entra publishes signing keys without an `alg` field; that is supported.
5. **Unverified:** whether your Entra configuration returns `auth_time` for the approval step-up. If the approval step is refused, that is the likely cause. The fallback is to keep password sign-in for approvers.

## Google Workspace

Standard OIDC. The issuer is `https://accounts.google.com`. Domain restriction comes from the `hd` claim in Google's own tooling, which this app does not read; use `allowedEmailDomains` (Google sends a verified `email`). Approval step-up through Google is likewise unproven.

## If something fails

The server prints one generic refusal and logs the outcome without secrets (see `docs/RUNBOOK.md`). Run `oidc check` first; it names the usual causes.
