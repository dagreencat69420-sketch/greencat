# syntax=docker/dockerfile:1
# GreenCat API + indexer worker image (apps/api).
#
# Build context MUST be the monorepo root (the API bundles packages/sdk at build time):
#   docker build -f apps/api/Dockerfile -t greencat-api .
# Run the HTTP API (runs SQL migrations on start, health check at GET /health):
#   docker run --env-file apps/api/.env -p 8787:8787 greencat-api
# Run the standalone indexer worker from the same image:
#   docker run --no-healthcheck --env-file apps/api/.env greencat-api node apps/api/dist/worker.js
#   (--no-healthcheck: the worker serves no HTTP, so the image HEALTHCHECK below does not apply)
# Run migrations only (idempotent; the API also runs them on start):
#   docker run --env-file apps/api/.env greencat-api node apps/api/dist/migrate.js
#
# No secrets are baked into the image. Pass everything at runtime (see docs/HOSTING-RUNBOOK.md).

ARG NODE_VERSION=20

# ---------- build stage ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo
# Workspace manifests first so `npm ci` is cached until a lockfile/manifest changes.
# npm validates every workspace listed in the root package.json, so copy all of them.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/sdk/package.json packages/sdk/package.json
# Only install what the API (and the SDK it bundles) needs, not the Next.js web app.
RUN npm ci --workspace=@greencat/api --workspace=@greencat/sdk --include-workspace-root --no-audit --no-fund
COPY packages/sdk packages/sdk
COPY apps/api apps/api
RUN npm run build --workspace=@greencat/api

# ---------- runtime stage ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/sdk/package.json packages/sdk/package.json
# Production deps only. The SDK workspace is included so its runtime deps (e.g. @noble/hashes),
# which stay external in the esbuild bundle, are installed.
RUN npm ci --omit=dev --workspace=@greencat/api --workspace=@greencat/sdk --include-workspace-root --no-audit --no-fund \
 && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
# PGlite fallback writes to ./data relative to the working dir; keep it writable for the non-root user.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
