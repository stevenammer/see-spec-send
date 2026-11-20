# OpenCode adapter

`--builder opencode` is an opt-in builder-contract v2 profile. The fixture remains the default. It receives an approved spec and adopted instructions only, then creates one short-lived, run-bound metering capability. It receives no person identity, session credential, provider credential, raw discussion, or comments.

The adapter uses the existing locked-container limits: `--network none`, non-root UID 65532, a read-only root, dropped capabilities, no new privileges, PID 32, 0.50 CPU, 64 MiB memory and swap, and a small noexec tmpfs. `/work` is its only writable bind mount. The image must contain OpenCode and `/entrypoint.sh`, which starts a loopback-only forwarder from `127.0.0.1:8787` to `/gateway/gateway.sock`, then starts OpenCode with `/work/opencode.json` and `/work/PROMPT.txt`. It writes source only in `/work/bundle` and its manifest at `/work/manifest.json`.

The generated config names the OpenAI-compatible metered chat gateway. An agent configured with its own provider key is labeled **spend not enforced** and refused for paid modes. Never pass provider keys, `--env-file`, host credentials, or an external proxy to this image.

An integrator must build from a reviewed Dockerfile, pin the OpenCode release and package digest, record its MIT license in `ACKNOWLEDGMENTS`, and replace the placeholder pin in `worker/opencode-image.digest` with the resulting image digest. Then pull that exact image, run `npm run test:container`, and perform one synthetic-task trial through the Unix-socket gateway, saving the receipt summary privately. This branch makes no claim that the image build, forwarder, Docker run, real agent, or live provider trial has happened.

Before a TRY is recorded, the host validates the bundle: relative allowlisted paths only (`html`, `css`, `js`, `json`, `svg`, `txt`, `md`), file and total-byte caps, no symlinks or executable files, exact hashes, no unexpected files, static HTML, and no external URL or network reference in source. The worker records the manifest only after validation and a fresh approval fence.


## Live trial record (synthetic task, 2026-11-16)

Build the image with `docker build -t sss-opencode:0 worker/opencode`, then record its image id in `worker/opencode-image.digest`. The base image and the agent release are pinned in `worker/opencode/Dockerfile` and `worker/opencode/package-lock.json`. `node scripts/opencode-container-trial.mjs` runs one approved synthetic spec through the adapter with real Docker, a Unix-socket gateway and Amazon Nova as the upstream model (a one-off synthetic trial in November 2026 through the metered proxy; it shows the plumbing works, not that the output is good). The container has no network. The agent wrote `index.html`, `style.css` and `app.js`; the host validated the bundle; three model calls settled through the meter (about 13,000 tokens in and 490 out). The container runs with 1 GiB of memory and 256 processes: the one-shot static builder's 64 MiB is far too small for an agent. The ready result stores the whole validated bundle. With `serve --bundle-port` it is shown from a separate, isolated origin so its script runs without any access to the app; without it, testers get a script-free page. Unverified: a longer task and other models.

## Refusals, repair, and what a bundle may contain (Nov 17, 2026)

The host's validator now says exactly why it refused a build (which file, which element or attribute), in words an agent can act on. If a finished build is refused and the reason is known, the same run gets **one** repair pass: the reason is written to `REPAIR.txt` in the work folder, the agent is started again on the files it already wrote, and the build is checked again. The repair uses a new capability on the same run, so the approval's dollar cap and the per-run call and token limits cover both attempts. It gets only the wall time that is left, and none if less than 45 seconds remain. A second refusal, or a failure the validator can't explain, ends the build as before. The first capability is revoked before the second starts.

A bundle may now use `<form>`, `<fieldset>` and `<legend>`. The attributes that would let a form submit anywhere (`action`, `method`, `target`, `formaction`) are still refused, so a form can only reload its own page. A single-file static page still refuses all three. This was an owner decision after the first builder evaluation showed models reach for form markup by habit ([BUILDER_EVAL.md](BUILDER_EVAL.md)).

