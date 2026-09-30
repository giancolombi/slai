# syntax=docker/dockerfile:1.7
# slai web (T-63): the Vite build served by unprivileged nginx with security
# headers, a CSP, SPA fallback and immutable caching of hashed assets. /api is
# proxied to API_UPSTREAM, so the browser talks to one origin (cookies, CSRF).
#   docker build -f deploy/docker/web.Dockerfile -t slai-web .
#   docker run -e API_UPSTREAM=http://api:8787 -p 8080:8080 slai-web
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter @slai/web build \
 && cd apps/web/dist \
 && find . -name '*.map' -delete \
 && rm -f mockServiceWorker.js

FROM ${NGINX_IMAGE} AS web
USER root
RUN apk upgrade --no-cache && rm -f /etc/nginx/conf.d/default.conf
COPY deploy/web/nginx.conf /etc/nginx/nginx.conf
COPY deploy/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
USER 101
# Rendered from the template at start into /tmp (the root filesystem can be read-only).
ENV PORT=8080 \
    API_UPSTREAM=http://api:8787 \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
    NGINX_ENTRYPOINT_QUIET_LOGS=1
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1"]
