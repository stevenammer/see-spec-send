# The application has no runtime npm dependencies, so there is no install step and nothing to fetch at build time.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
WORKDIR /app
# Files are root-owned and read-only to the app user. What is excluded is listed in .dockerignore.
COPY --chown=root:root . .
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production SSS_DB=/data/sss.db
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "cli.js", "serve", "--host", "0.0.0.0", "--port", "8080", "--trusted-proxy"]
