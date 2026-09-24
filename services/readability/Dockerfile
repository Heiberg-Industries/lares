# services/readability/Dockerfile
# Contained URL→text service. Mozilla Readability + SSRF guard. No LLM calls.
# This is the ONLY component in the portfolio with general web egress.
#
# Multi-stage: `deps` installs the readability closure; `runtime` is a slim
# non-root image that runs the entrypoint via tsx (no compile step).
#
# Build context = the REPO ROOT. CI must pass
# `-f services/readability/Dockerfile .` from the root.

# ---- deps: install workspace closure ----------------------------------------
FROM node:22-bookworm AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy only the manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# pnpm patches (patchedDependencies in the root package.json) — pnpm install fails
# outright if a referenced patch file is missing from the context.
COPY patches patches
COPY services/readability/package.json services/readability/package.json

# Install the readability dependency closure only (the `...` includes deps).
# Full install (not --prod) so `tsx` is present to run the entrypoint.
RUN pnpm install --frozen-lockfile --filter @lares/readability...

# Now copy the source.
COPY services/readability services/readability

# ---- runtime: slim, non-root ------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    HOME=/tmp
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # Non-root runtime user (UID/GID 10002).
    && groupadd -g 10002 readability && useradd -u 10002 -g 10002 -m -s /usr/sbin/nologin readability
WORKDIR /app
COPY --from=deps /app /app
USER 10002:10002
EXPOSE 8080

# Run tsx DIRECTLY (hoisted binary) — NOT via `pnpm exec`, which goes through
# corepack and downloads pnpm from npm on every cold start. Under an egress
# firewall npm is blocked, so the corepack path crash-loops the container.
CMD ["/app/node_modules/.bin/tsx", "services/readability/bin/serve.ts"]
