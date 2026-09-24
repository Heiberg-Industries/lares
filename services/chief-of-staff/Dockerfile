# Built by GitHub Actions on linux/amd64. NEVER built on the box.
# Multi-stage: `deps` installs the eve-saga workspace closure and runs `eve build`
# (per node_modules/eve/docs/guides/deployment/self-hosting.md — eve compiles the agent to a
# self-contained Nitro server under .output/); `runtime` is a slim non-root image that runs
# the built server via `eve start`, the OTHER half of that doc's documented self-host recipe
# ("eve build" then "eve start --host 0.0.0.0"). `eve start` is NOT a thin `node
# .output/server/index.mjs` wrapper — it calls eve's own production-host loader
# (dist/src/cli/run.js -> #internal/nitro/host.js:startProductionServer), so the eve package
# and its dependency closure have to ship in the runtime image too, not just .output/ — same
# reasoning as agent-runtime/Dockerfile shipping tsx to run its entrypoint.
#
# Build context = the REPO ROOT (not this directory) — eve-saga is a pnpm workspace member
# with no lockfile of its own, so `pnpm install --filter lares-chief-of-staff...` needs the root
# pnpm-workspace.yaml + pnpm-lock.yaml. CI must pass `-f services/chief-of-staff/Dockerfile .`
# from the root (mirrors services/agent-runtime/Dockerfile's convention).

# ---- builder: install the eve-saga workspace closure and build -----------------
# eve 0.32.0 requires Node >=24 (package.json "engines") — confirmed the hard way: `eve
# build` refuses to run under node:22-bookworm ("eve requires Node.js >=24"). This deviates
# from agent-runtime/Dockerfile's node:22 base deliberately; the non-root UID/GID pattern is
# still mirrored exactly.
FROM node:24-bookworm AS builder
# eve's CLI has posted usage data to telemetry.vercel.com since 0.52.0 unless this is set
# (docs/reference/telemetry.md in the eve package). Must be set before the install step below,
# not just before `eve build`: @lares/agent-kit's `prepare` script is `eve extension build`,
# and pnpm runs a workspace package's prepare during install. "Nothing phones home" is
# unconditional (root CLAUDE.md), and these images are built in CI with a live network.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH EVE_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy only the manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# pnpm patches (patchedDependencies in the root package.json) — pnpm install fails
# outright if a referenced patch file is missing from the context.
COPY patches patches
COPY services/chief-of-staff/package.json services/chief-of-staff/package.json
COPY services/network/package.json  services/network/package.json
COPY packages/junk/package.json     packages/junk/package.json
COPY packages/strength/package.json packages/strength/package.json
COPY packages/compose-contract/package.json packages/compose-contract/package.json
# Full source, not just the manifest — @lares/agent-kit now ships an eve extension
# (ORB-143) and its package.json declares a "prepare": "eve extension build" script
# (eve's own scaffold convention, node_modules/eve/docs/extensions.md). pnpm runs a
# workspace-local package's `prepare` script during `pnpm install` itself, before the
# other packages' full-source COPY below ever runs — a manifest-only copy here left
# `extension/` missing and `eve extension build` failed with ENOENT scanning it.
# Caching trade-off: this moves agent-kit ahead of the `pnpm install` layer below, so ANY
# change to agent-kit's source (not just package.json or extension/) now busts that
# install layer's cache — previously only the later, cheaper COPY+build layers were
# invalidated. Every other package here keeps the manifest-then-source split and its
# caching benefit; only agent-kit needed to move, because it's the only one with a
# `prepare` script that needs its own source present at install time.
COPY packages/agent-kit packages/agent-kit
# vault-format in FULL before install: agent-kit re-exports from it, and agent-kit's `prepare`
# script type-checks during `pnpm install` — a package.json alone leaves those imports unresolved.
COPY packages/vault-format packages/vault-format

# eve-saga depends on @lares/network (workspace:^), which itself depends on @lares/junk and
# @lares/strength (see services/network/package.json) — this filter installs eve-saga's own
# closure (eve, ai, @ai-sdk/*, @workflow/world-postgres, zod) PLUS that sibling-package
# closure, plus dev deps (vitest/typescript) needed for `pnpm typecheck`/`pnpm test`
# upstream; not --prod, since `eve` itself is a normal "dependencies" entry (not dev-only)
# either way. `--filter lares-chief-of-staff...` resolves this automatically once all the manifests
# above are present — no extra `--filter` flags needed. This also runs @lares/agent-kit's
# `prepare` script (see the COPY above), building its extension's dist/ tree so it exists
# by the time eve-saga's own `eve build` compiles the agent below.
RUN pnpm install --frozen-lockfile --filter lares-chief-of-staff...

COPY services/chief-of-staff services/chief-of-staff
COPY services/network      services/network
COPY packages/junk         packages/junk
COPY packages/strength     packages/strength
COPY packages/compose-contract packages/compose-contract

# `eve build` writes the Nitro server under services/chief-of-staff/.output/ (self-hosting.md).
# Must run from the eve-saga app root (package.json + agent/), not the repo root.
WORKDIR /app/services/chief-of-staff

# agent/persona.md is an ASSEMBLED artefact (ORB-145): agent.json + the shared
# chief-of-staff role template + agent/voice.md. This build deliberately does NOT assemble it —
# it compiles the COMMITTED file, so what ships is what was reviewed — which means a commit that
# edited any of those three inputs without re-running `pnpm run assemble` would ship stale
# instructions with nothing to notice. `--check` re-assembles in memory, compares byte-for-byte,
# writes nothing, and fails the build naming the file. It must run BEFORE `eve build`, so a
# stale persona costs seconds rather than a full Nitro compile.
# ---- BUILDER IMAGE ENDS HERE ----
# Published as ghcr.io/heiberg-industries/lares-chief-of-staff:<tag>. An overlay's Dockerfile does:
#   FROM ghcr.io/heiberg-industries/lares-chief-of-staff:<tag> AS build
#   COPY agents/<name>/agent.json  /app/services/chief-of-staff/agent.json
#   COPY agents/<name>/agent/      /app/services/chief-of-staff/agent/
#   (Absolute destinations: this builder's WORKDIR is /app/services/chief-of-staff, so a
#   relative destination lands one level too deep and silently ships the neutral persona.)
#   RUN pnpm run assemble:check && pnpm exec eve build
#   FROM ghcr.io/heiberg-industries/lares-runtime-base:<tag>
#   COPY --from=build /app /app   (+ the mkdir/chown/USER/CMD lines from the overlay template)
# The neutral default agent.json/voice.md in this tree let the engine build and test with no overlay.
WORKDIR /app/services/chief-of-staff

# CI-only neutral runtime target. Default final stage below preserves the overlay builder contract.
FROM builder AS compiled-runtime
RUN pnpm run assemble:check && pnpm exec eve build
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 eve && useradd -u 10001 -g 10001 -m -s /usr/sbin/nologin eve
COPY --from=compiled-runtime /app /app
COPY images/agent-runtime/start.sh /usr/local/bin/lares-start
# Generated from SETTINGS — the startup guard lares-start runs. Same COPY layer as lares-start, so
# it cannot be missing at runtime; the image has no TypeScript loader before `eve start`, so the
# check that runs here is shell, generated from the same list `checkSettings` walks.
COPY images/agent-runtime/required-settings.sh /usr/local/lib/lares/required-settings.sh
RUN chmod 0755 /usr/local/bin/lares-start /usr/local/lib/lares/required-settings.sh && mkdir -p /app/services/chief-of-staff/.eve/.workflow-data \
    && chown -R 10001:10001 /app/services/chief-of-staff/.eve
USER 10001:10001
WORKDIR /app/services/chief-of-staff
CMD ["/usr/local/bin/lares-start"]

FROM builder AS default-builder
