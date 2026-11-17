# Builder image for the opt-in OpenCode profile. Build, then record the image id in worker/opencode-image.digest.
#   docker build -t sss-opencode:0 worker/opencode
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g opencode-ai@1.19.5 --no-audit --no-fund
COPY forward.mjs manifest.mjs entrypoint.sh /
RUN chmod 0755 /entrypoint.sh
USER 65532:65532
ENTRYPOINT []
