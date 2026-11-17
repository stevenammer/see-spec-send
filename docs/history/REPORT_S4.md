# S4 report

Implemented the adapter-side S4 work without changing `core/machine.js`.

- Builder contract v2 now declares the `bundle` capability. The fixture remains the CLI default. `opencode` is registered only when explicitly selected.
- Added `worker/bundle.js`: a pure, bounded, no-follow bundle validator with a manifest hash. It rejects traversal, symlinks, executable files, unexpected files, oversize bundles, disallowed extensions, external URLs, and network references.
- Added `worker/opencode.js`: a durable, fake-Docker-testable adapter that mints only a run-bound gateway capability, generates OpenCode config and approved-only prompt material, applies the locked container flags, validates a finished bundle before returning ready, and fences stop/restart. A self-key paid mode is refused with `spend not enforced`.
- Added migration 17 for durable OpenCode job rows and updated the schema-version test.
- Added `test/opencode-adapter.test.mjs` for adapter controls and hostile bundle inputs. Updated contract tests and documentation in `docs/OPENCODE.md`, `docs/ADAPTER.md`, and `docs/STATUS.md`.

Verification completed:

- `node --test test/opencode-adapter.test.mjs test/builder-adapter-contract.test.mjs test/slice21.test.mjs` passed.
- The full `npm test` run was started. Tests through `slice22` showed the S4 tests passing, but the overall suite did not pass in this sandbox. Existing loopback-listening tests fail with `EPERM`, including five tests in `test/gateway.test.mjs` and one in `test/provider.test.mjs`. `test/provider.test.mjs` also had two pre-existing local-command malformed-JSON failures. The run was stopped before completion after those failures and a long-running later test.

Not run:

- `npm run test:container` was not run. It requires Docker and a locally available pinned image, neither of which this sandbox is authorized to use.
- No OpenCode image build, package install, image pull, forwarder verification, Docker run, model/provider call, or live synthetic trial was attempted.

Integrator follow-up is explicitly documented in `docs/OPENCODE.md`: replace the placeholder image digest with a reviewed OpenCode image pin, record its MIT acknowledgement, run the Docker acceptance suite, and record one synthetic trial receipt summary privately. The current `opencode-image.digest` is deliberately only a placeholder compatible with the existing pin parser, not a claim that OpenCode is installed in it.
