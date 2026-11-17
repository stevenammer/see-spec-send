# Builder image for the opt-in Codex profile. Build, then record the image id in worker/codex-image.digest.
#   docker build -t sss-codex:0 worker/codex
# Codex is OpenAI's agent CLI. It is installed from npm at a pinned version and runs under OpenAI's own terms; this
# repository does not redistribute it. It holds no provider key: it talks only to the metered gateway.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.167.0 --no-audit --no-fund
COPY forward.mjs manifest.mjs entrypoint.sh /
RUN chmod 0755 /entrypoint.sh
USER 65532:65532
ENTRYPOINT []
