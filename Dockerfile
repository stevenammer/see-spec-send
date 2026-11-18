# The application has no runtime npm dependencies, so there is no install step and nothing to fetch at build time.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
# Files are root-owned and read-only to the app user. What is excluded is listed in .dockerignore.
COPY --chown=root:root . .
# npm and yarn ship inside the Node image with their own dependencies, and this app never runs them. Removing them
# takes their known vulnerabilities out of the image along with the tools.
RUN mkdir -p /data && chown node:node /data \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*  /usr/local/bin/yarn /usr/local/bin/yarnpkg
# hadolint ignore=DL3066
USER node
ENV NODE_ENV=production SSS_DB=/data/sss.db
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "cli.js", "serve", "--host", "0.0.0.0", "--port", "8080", "--trusted-proxy"]
