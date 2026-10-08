# Built in CI only. No dependency installation or build on the installation host.
FROM docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32 AS dockercli
FROM node:24-bookworm-slim AS build
ENV EVE_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/ ./services/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @lares/keeper...
RUN pnpm --filter @lares/agent-kit build

# Preserve the installed workspace and compiled extension, but not build-stage
# package managers/caches. Keeper's runtime invokes tsx and Docker directly.
FROM node:24-bookworm-slim AS runtime
ENV EVE_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# Installation hosts run prepared code, never a package installer. Keep workspace
# dependencies intact; remove only the base image's unused build/package managers.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /app /app
CMD ["/app/services/keeper/node_modules/.bin/tsx", "/app/services/keeper/bin/keeper.ts", "serve"]
