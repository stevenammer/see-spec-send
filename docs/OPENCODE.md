# OpenCode adapter

`--builder opencode` is an opt-in builder-contract v2 profile. The fixture remains the default. It receives an approved spec and adopted instructions only, then creates one short-lived, run-bound metering capability. It receives no person identity, session credential, provider credential, raw discussion, or comments.

The adapter uses the existing locked-container limits: `--network none`, non-root UID 65532, a read-only root, dropped capabilities, no new privileges, PID 32, 0.50 CPU, 64 MiB memory and swap, and a small noexec tmpfs. `/work` is its only writable bind mount. The image must contain OpenCode and `/entrypoint.sh`, which starts a loopback-only forwarder from `127.0.0.1:8787` to `/gateway/gateway.sock`, then starts OpenCode with `/work/opencode.json` and `/work/PROMPT.txt`. It writes source only in `/work/bundle` and its manifest at `/work/manifest.json`.

The generated config names the OpenAI-compatible metered chat gateway. An agent configured with its own provider key is labeled **spend not enforced** and refused for paid modes. Never pass provider keys, `--env-file`, host credentials, or an external proxy to this image.

An integrator must build from a reviewed Dockerfile, pin the OpenCode release and package digest, record its MIT license in `ACKNOWLEDGMENTS`, and replace the placeholder pin in `worker/opencode-image.digest` with the resulting image digest. Then pull that exact image, run `npm run test:container`, and perform one synthetic-task trial through the Unix-socket gateway, saving the receipt summary privately. This branch makes no claim that the image build, forwarder, Docker run, real agent, or live provider trial has happened.

Before a TRY is recorded, the host validates the bundle: relative allowlisted paths only (`html`, `css`, `js`, `json`, `svg`, `txt`, `md`), file and total-byte caps, no symlinks or executable files, exact hashes, no unexpected files, static HTML, and no external URL or network reference in source. The worker records the manifest only after validation and a fresh approval fence.
