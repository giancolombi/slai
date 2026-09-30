# syntax=docker/dockerfile:1.7
# slai API (T-63). Build from the repo root:
#   docker build -f deploy/docker/api.Dockerfile -t slai-api .
# The same image runs migrations (the `migrate` target just changes the command):
#   docker run --rm --env-file … slai-api node dist/migrate.mjs
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN node deploy/bundle.mjs api /out/dist \
 && mkdir -p /out/node_modules/@node-rs \
 && cp -rL node_modules/.pnpm/node_modules/@node-rs/. /out/node_modules/@node-rs/ \
 && cp -r packages/db/migrations /out/migrations

FROM ${NODE_IMAGE} AS runtime
# The bundle needs only node: drop npm, corepack and yarn (smaller, fewer CVEs) and take OS fixes.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# Owned by root and read-only to the runtime user: the container can run with a read-only root filesystem.
COPY --from=build /out/ ./
ENV NODE_ENV=production \
    PORT=8787 \
    SLAI_MIGRATIONS_DIR=/app/migrations
USER node
EXPOSE 8787

FROM runtime AS migrate
CMD ["node", "dist/migrate.mjs"]

FROM runtime AS api
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/api.mjs"]
