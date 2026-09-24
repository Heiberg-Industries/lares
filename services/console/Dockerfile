# services/console/Dockerfile
# Built by GitHub Actions on linux/amd64. NEVER built on the box.
# Multi-stage: `deps` installs the full workspace closure; `build` runs
# `next build` (produces standalone output); `run` is a slim non-root image.
#
# Build context = the REPO ROOT (not this directory), so CI must pass
# `-f services/console/Dockerfile .` from the root.

# ---- deps: install workspace closure ----------------------------------------
# node:24-bookworm (full, not -slim), not node:22-slim: @lares/agent-kit's "prepare" script
# (below) runs `eve extension build`, and eve requires Node >=24 (confirmed the hard way
# here — the original console CI failure was this exact "eve requires Node.js >=24" error,
# not an ENOENT for missing source, same as services/chief-of-staff/Dockerfile's builder
# stage, which is why that stage — and services/travel's and services/creative's — use this
# same "node:24-bookworm" tag). The full (non-slim) variant specifically: this filtered
# install also compiles native addons pulled in by the console's workspace closure
# (better-sqlite3, node-liblzma, …), and only the full Debian image ships python3/gcc/make —
# confirmed the hard way too: node:24-bookworm-slim has no prebuilt binary for better-sqlite3
# on Node 24 and falls back to node-gyp, which then fails with "Could not find any Python
# installation". `build` and `run` below stay on node:24-bookworm-slim (same Debian base,
# same glibc/Node ABI, just lighter — no compiling happens after `deps`).
FROM node:24-bookworm AS deps
# agent-kit's `prepare` is `eve extension build`, so this image's pnpm install is an eve CLI run:
# eve's CLI telemetry is switched off before it (nothing phones home).
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH EVE_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy only the manifests first for layer caching.
# @lares/console depends on @lares/agent-kit, @lares/agent-box and @lares/taste (direct),
# which in turn depend on @lares/network → @lares/strength.
# EVERY workspace dependency needs its manifest here: a filtered install fails outright on a
# workspace dep the lockfile names but the context has no package.json for.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# pnpm patches (`patchedDependencies` in the root package.json) — pnpm hashes every referenced
# patch file at install time, so a filtered install fails outright with ENOENT if the context
# has no `patches/`. It does this even for a filter that pulls in nothing patched, which is why
# this image broke the moment `eve` acquired a patch it does not depend on.
COPY patches patches
COPY services/console/package.json       services/console/package.json
# Full source, not just the manifest — @lares/agent-kit ships an eve extension (ORB-143)
# and its package.json declares a "prepare": "eve extension build" script that pnpm runs
# during `pnpm install` itself, before any later full-source COPY; a manifest-only copy
# here leaves extension/ missing and `eve extension build` fails with ENOENT. Same reason
# the role Dockerfiles (e.g. services/chief-of-staff/Dockerfile) copy the full package.
COPY packages/agent-kit packages/agent-kit
# vault-format in FULL before install: agent-kit re-exports from it, and agent-kit's `prepare`
# script type-checks during `pnpm install` — a package.json alone leaves those imports unresolved.
COPY packages/vault-format packages/vault-format
COPY services/box/package.json     services/box/package.json
COPY services/network/package.json       services/network/package.json
COPY packages/strength/package.json      packages/strength/package.json
COPY packages/taste/package.json         packages/taste/package.json

# Install the console dependency closure (the `...` pulls in workspace deps).
RUN pnpm install --frozen-lockfile --filter @lares/console...

# ---- build: next build -------------------------------------------------------
# Same tag as `deps` (see its comment) — this stage copies deps' node_modules verbatim.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/console/node_modules ./services/console/node_modules
COPY . .

RUN pnpm --filter @lares/console build

# ---- run: slim, non-root image -----------------------------------------------
# Same tag as `deps`/`build` (see `deps`' comment) — the standalone output can trace in
# native addons built under that Node ABI.
FROM node:24-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --from=build /app/services/console/.next/standalone ./
COPY --from=build /app/services/console/.next/static ./services/console/.next/static
COPY images/console-runtime/start.sh /usr/local/bin/lares-console-start
RUN chmod 0755 /usr/local/bin/lares-console-start

RUN groupadd -g 10001 console && useradd -u 10001 -g 10001 -m -s /usr/sbin/nologin console
USER 10001:10001
EXPOSE 3000
CMD ["/usr/local/bin/lares-console-start"]
