# Built in CI only. No dependency installation or build on the installation host.
FROM docker:27-cli AS dockercli
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/ ./services/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @lares/keeper...
RUN pnpm --filter @lares/agent-kit build
CMD ["/app/services/keeper/node_modules/.bin/tsx", "/app/services/keeper/bin/keeper.ts", "serve"]
