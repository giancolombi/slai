# slai agent sandbox: E2B template (v2 build system; v1 `e2b template build` stopped working 2026-08-01).
#
# Build and pin:
#   1. pnpm --filter @slai/agents build:sandbox       # bundles packages/agents into sandbox/dist/runner.js
#   2. E2B_API_KEY=... pnpm --filter @slai/agents sandbox:template
#      Builds this file via Template().fromDockerfile() and prints E2B_TEMPLATE=slai-agent:<buildId>.
#   3. Set E2B_TEMPLATE to exactly that `slai-agent:<buildId>`. The build id is immutable.
#      Never use a bare name or a tag (`slai-agent`, `:default`, `:latest`): tags are mutable
#      and the runtime refuses them (parsePinnedTemplate). Rebuild and re-pin to roll out changes;
#      keep the previous build id to roll back.
#
# At runtime the worker creates one sandbox per agent run, writes /work/manifest.json, runs
# `node /opt/slai/runner.js` with a timeout, reads /work/result.json and kills the sandbox.
# Egress is denied except the model API hosts; auth headers are injected by E2B's egress proxy.
FROM node:24-slim

ENV NODE_ENV=production \
    # Trust the OS CA store as well as Node's bundled roots, so TLS through the egress proxy verifies.
    NODE_USE_SYSTEM_CA=1

RUN mkdir -p /opt/slai /work && chmod 0777 /work

COPY dist/runner.js /opt/slai/runner.js

WORKDIR /work
