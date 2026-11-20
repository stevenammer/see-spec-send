# Builder image for the opt-in Claude Code profile. Build, then record the image id in worker/claudecode-image.digest.
#   docker build -t sss-claudecode:0 worker/claudecode
# Claude Code is Anthropic's agent CLI. It is installed from npm at a pinned version and runs under Anthropic's own
# terms; this repository does not redistribute it. It holds no provider key: it talks only to the metered gateway.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The CLI is installed from a committed lockfile (package.json pins the version, package-lock.json carries the
# integrity hashes), so the build cannot pick up different bytes than the ones reviewed.
COPY package.json package-lock.json /opt/cli/
RUN npm ci --prefix /opt/cli --omit=dev --no-audit --no-fund \
 && ln -s /opt/cli/node_modules/.bin/claude /usr/local/bin/claude
COPY forward.mjs manifest.mjs entrypoint.sh /
RUN chmod 0755 /entrypoint.sh
USER 65532:65532
ENTRYPOINT []
