# services/sync-jobs/Dockerfile
# Built by GitHub Actions on linux/amd64. NEVER built on the box.
#
# ONE IMAGE, TWO SCHEDULED JOBS — AND NOTHING ELSE, EVER. This image carries the box's
# cron-shaped jobs: notion-sync (hourly Notion ↔ vault) and atlas-sync (daily Atlas Part B).
# Both are brand-neutral, both tick in-process under `restart: unless-stopped`, both take a DB
# and a Notion token, and neither is an agent. THE RULE (ORB-178, decided 2026-09-04): this
# image never carries an agent, a persona, a door or a route. A job of a different shape gets
# its own Dockerfile — the escape hatch is a second image, not a bigger one. The old
# lares-agent-runtime image died of the opposite habit ("one image, many bins" with no rule
# about which bins), and its dependency debt became the fleet's only critical.
#
# Shape mirrors the retired services/agent-runtime/Dockerfile: `deps` installs the two jobs'
# workspace closure (native better-sqlite3 links for amd64 here, via @lares/network), `runtime`
# is slim + non-root and runs the entrypoint via tsx — no compile step, the jobs ship as source.
# Build context = the REPO ROOT: `-f services/sync-jobs/Dockerfile .`

# ---- deps: install the two jobs' workspace closure ---------------------------------------
FROM node:22-bookworm AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# pnpm patches (patchedDependencies in the root package.json) — pnpm install fails outright
# if a referenced patch file is missing from the context (memory: every service image).
COPY patches patches
# EXACTLY the workspace closure of `@lares/notion-sync...` + `@lares/atlas...` (measured in
# ORB-178 Task 1, re-measured for Task 2 after Task 1 dropped notion-sync's agent-runtime
# dependency — that took packages/compose-contract out of the closure with it, since it was
# only ever pulled in transitively). A filtered install fails on a workspace dep the lockfile
# names and the context lacks — so a new workspace dependency of either job must be added HERE
# too.
COPY services/notion-sync/package.json     services/notion-sync/package.json
COPY services/atlas/package.json           services/atlas/package.json
COPY services/box/package.json       services/box/package.json
COPY services/network/package.json         services/network/package.json
COPY packages/strength/package.json        packages/strength/package.json
COPY packages/junk/package.json            packages/junk/package.json
COPY packages/vault-format/package.json    packages/vault-format/package.json

# Full install (not --prod): tsx is needed to run the entrypoints.
RUN pnpm install --frozen-lockfile --filter @lares/notion-sync... --filter @lares/atlas...

COPY services/notion-sync     services/notion-sync
COPY services/atlas           services/atlas
COPY services/box       services/box
COPY services/network         services/network
COPY packages/strength        packages/strength
COPY packages/junk            packages/junk
COPY packages/vault-format    packages/vault-format

# ---- runtime: slim, non-root --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    HOME=/tmp
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
    # git: both jobs commit into bind-mounted repos (/srv/brain, /srv/atlas).
    && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # UID/GID 10001 — the box's shared non-root id (secret files are root:saga(10001) 440;
    # /srv/brain and /srv/atlas are writable by that group). The in-container NAME is
    # irrelevant, the NUMBER is load-bearing.
    && groupadd -g 10001 jobs && useradd -u 10001 -g 10001 -m -s /usr/sbin/nologin jobs
WORKDIR /app
# The whole tree, layout preserved: pnpm's node_modules are RELATIVE symlinks into the
# workspace-root store, so copying one service alone breaks every import.
COPY --from=deps /app /app
USER 10001:10001

# tsx DIRECTLY (hoisted binary), never `pnpm exec` — corepack would try to fetch pnpm from npm
# on a cold start, which the box's egress firewall blocks (crash-loop). WORKDIR stays /app so
# the runbooks' `docker compose exec ... tsx services/<job>/bin/<job>.ts` recipes are unchanged.
#
# No real default command on purpose: compose MUST name the job. A block that forgets
# `command:` fails here, visibly, instead of silently running one job under the other's name.
CMD ["sh", "-c", "echo 'lares-sync-jobs: no job named. Set command: to one of' >&2; echo '  /app/node_modules/.bin/tsx services/notion-sync/bin/notion-sync.ts' >&2; echo '  /app/node_modules/.bin/tsx services/atlas/bin/atlas-sync.ts' >&2; exit 1"]
