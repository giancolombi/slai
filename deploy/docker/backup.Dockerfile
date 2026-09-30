# syntax=docker/dockerfile:1.7
# slai backup (T-63, TR-33): `db:backup --upload` as a one-shot/cron container.
# pg_dump comes from the Postgres image matching the server's major version.
#   docker build -f deploy/docker/backup.Dockerfile -t slai-backup .
ARG NODE_IMAGE=node:24-alpine
ARG PG_IMAGE=postgres:18-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN node deploy/bundle.mjs ops /out/dist

FROM ${NODE_IMAGE} AS node

FROM ${PG_IMAGE} AS backup
# gosu (a Go binary with its own CVEs) only serves the server entrypoint, which this image never runs.
RUN apk upgrade --no-cache && apk add --no-cache libstdc++ && rm -f /usr/local/bin/gosu
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /out/ ./
ENV NODE_ENV=production PG_TOOLS=local BACKUP_DIR=/tmp/backups
USER postgres
ENTRYPOINT []
CMD ["node", "dist/backup.mjs", "--upload"]
