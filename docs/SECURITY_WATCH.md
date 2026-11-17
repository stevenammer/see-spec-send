# Security watch (November 2026)

What was checked against current public security news, what it means for this project, and what is still open. This is a dated snapshot, not a guarantee. Secondary sources often disagree on version numbers, so every fix level below should be confirmed on the vendor's own advisory page before you rely on it.

## Runtime and container layer

| Topic | What was reported | Where we stand |
|---|---|---|
| Node.js 22 security releases (June and July 2026) | Several coordinated releases fixed a TLS wildcard-matching bypass, WebCrypto crashes and other issues. Secondary sources disagree on exact version numbers. Node 20 is end of life; Node 22 is security-only until April 2027. | Development and CI use the newest 22.x. `doctor` warns below 22.23. Confirm the floor on the Node.js vulnerability blog; do not trust a blog's version number. The Dockerfile pins the base image by digest, so rebuild when a new patch ships. |
| runc container escapes (2025 set; July 2026 CVE-2026-41579) | Malicious images or mounts could escape or damage the host. Reported fixed in runc 1.3.6, 1.4.3 and 1.5.0. | Check the runc version on your own builder host (`runc --version`). The builder container runs with networking off (its only channel out is a socket to the metered gateway), a read-only root, an unprivileged user, all capabilities dropped, no-new-privileges, and CPU, memory and process limits. Keep runc patched on any machine that runs the builder. |

## AI agent layer

| Topic | What was reported | Where we stand |
|---|---|---|
| "Trust handoff" sandbox escapes in coding agents (mid 2026) | Researchers escaped several well-known coding agents' sandboxes without breaking the sandbox itself, by getting the agent to write files (hook or settings files, project config) that an unsandboxed tool or the host later trusted. Separate reports described prompt injection steering an agent outside its working directory. Vendors responded differently; some did not patch. | Design point: nothing on the host ever executes or trusts a file the builder wrote. A build leaves the container only as a validated bundle (fixed file types, size limits, no symlinks, rejects files that change while being read) and is shown only on a separate origin with a strict content security policy. The builder runs in that locked container. The repository's one host-side `git init` is in a manual trial script on a directory the script creates, and nothing runs hooks from it. **Open:** no outside party has tested this boundary. |
| OWASP lists for LLM and agentic applications (2026) | Prompt injection stays first; excessive agency rose sharply; agent goal hijack, tool misuse, privilege abuse and memory poisoning are named risks. | Models here can only draft text. Approval, spending and anything that acts stay with named humans (step-up required). Model answers are labeled, refuse when sources are missing, and cannot change decisions. The remaining exposure is injected text in internal posts reaching a model; those calls carry no tools and no secrets. **Open:** a systematic prompt-injection test set is not built yet. |

## Identity layer

| Topic | What was reported | Where we stand |
|---|---|---|
| OAuth 2.0 Security BCP (RFC 9700, January 2025) | Mandates mix-up defenses when more than one authorization server is possible, PKCE tied to the starting browser, and rejection of PKCE downgrade. | We use PKCE S256 bound to a per-browser cookie, a one-time state, exact issuer pinning, and since this round check the `iss` callback parameter (RFC 9207) when the provider sends one. Tested against a certified independent OIDC implementation in a real browser. **Open:** not yet tested against Entra, Okta or Google tenants. |

## Dependencies

The application has no runtime npm dependencies, which removes most supply-chain exposure by design. Development tooling (browser automation, accessibility audit) is pinned in CI. `scripts/sbom.mjs` and `scripts/audit-deps.mjs` produce a bill of materials and check known advisories when run online.

## How to keep this current

1. Subscribe to the Node.js security announcements and to runc and Docker advisories for any machine that runs the builder.
2. Re-run this review before any pilot and after any change to the builder, bundle viewer or sign-in code.
3. Treat a vendor's severity rating as an input, not the answer: several of the 2026 agent sandbox issues were rated low by the vendor and were serious in practice.

Sources consulted (public): Node.js project vulnerability announcements; runc security advisories; Cloud Security Alliance research note on coding-agent sandbox escapes (July 2026); Pillar Security and Cato Networks disclosures as reported by trade press; IETF RFC 9700 and RFC 9207; OWASP GenAI Security Project lists.
