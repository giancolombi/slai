# syntax=docker/dockerfile:1.7
# slai worker (T-63): pg-boss consumers, the timer sweep, retention. Not public;
# GET /healthz on HEALTH_PORT (8788) reports sweep liveness.
#   docker build -f deploy/docker/worker.Dockerfile -t slai-worker .
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN node deploy/bundle.mjs worker /out/dist \
 && mkdir -p /out/node_modules/@node-rs \
 && cp -rL node_modules/.pnpm/node_modules/@node-rs/. /out/node_modules/@node-rs/

FROM ${NODE_IMAGE} AS worker
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /out/ ./
ENV NODE_ENV=production HEALTH_PORT=8788
USER node
EXPOSE 8788
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/worker.mjs"]
