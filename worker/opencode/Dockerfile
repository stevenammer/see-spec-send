# Builder image for the opt-in OpenCode profile. Build, then record the image id in worker/opencode-image.digest.
#   docker build -t sss-opencode:0 worker/opencode
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g opencode-ai@1.19.5 --no-audit --no-fund
COPY forward.mjs manifest.mjs entrypoint.sh /
RUN chmod 0755 /entrypoint.sh
USER 65532:65532
ENTRYPOINT []
