# Acknowledgments

Only things this repository actually uses, tests against or documents are listed. Licenses are the projects' own; check them before you redistribute anything.

## Used by the code

- **Node.js** (OpenJSF): the runtime, the built-in test runner and `node:sqlite`. The server has no npm runtime dependencies.
- **SQLite**: the default store, through Node's built-in binding.

## Standards the login follows

- **OpenID Connect Core 1.0** (OpenID Foundation) and **OAuth 2.0 Authorization Code with PKCE** (RFC 7636, IETF). The OIDC adapter is tested against an in-process fake provider only. It has not been run against a real identity provider.
- **PostgreSQL**: the store adapter targets it, but it is tested only against an in-process fake. No driver or database ships here.

## Used only in tests you run yourself

- **Playwright** and **Google Chrome**: the optional end-to-end and artifact-origin tests drive a real browser. Neither is bundled; you point the tests at your own install.

## Mentioned, not integrated

- **OpenHands** and **Docker**: the builder adapter is designed around that kind of sandboxed agent runner, but no OpenHands code or Docker image is used or proven here (see docs/ADAPTER.md).

## How it was made

Steven Ammer sets the requirements and makes the product decisions. Implementation is AI-assisted: Anthropic's Claude and OpenAI's Codex wrote and reviewed code under his direction, and a human gates every build. If something is missing or wrong here, open an issue.
