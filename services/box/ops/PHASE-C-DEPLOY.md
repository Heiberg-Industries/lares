# Phase C — Saga live cutover runbook (human-in-loop)

Everything in the build plan is done: image pipeline, gated-OFF `saga` service,
egress files, brain push-to-bare, and the pre-live cleanups. These are the
remaining steps that need real credentials, box access, or the gate flip.
Do them in order. Each is reversible.

## 1. Confirm the image built
- Open GitHub → Actions → "agent-runtime image" → latest run on `main`.
- Copy the digest from the run **Summary** (`ghcr.io/heiberg-industries/lares-agent-runtime@sha256:…`).
- **Note:** the CI run also produces a `better-sqlite3-linux-x64` artifact for the
  Stage-4 verifier. If that artifact is EMPTY, the extraction path drifted — check
  that `/app/node_modules/.pnpm` exists in the image.

## 2. Provision the GHCR pull token (box can pull a private image)
- Create a GitHub PAT with `read:packages` (classic) scoped to the org.
- On the box: `echo <PAT> | docker login ghcr.io -u <github-user> --password-stdin`
  (writes `~/.docker/config.json` for the user running compose; root if compose runs as root).

## 3. Provision the four runtime secrets (root-only, on the LUKS disk)
Create each file with `umask 077`, root:root, mode 0400, under `/etc/agent-box/`:
- `gateway-key`     — the LiteLLM gateway API key
- `slack-app-token` — Slack app-level token (`xapp-…`, Socket Mode enabled)
- `slack-bot-token` — Slack bot token (`xoxb-…`, with chat:write, reactions:read, im:history)
- `twenty-key`      — Twenty CRM API key
`db-password` already exists from Stage 2.

> **Caution:** `PGPASSWORD` must NOT be set in `compose.yaml` or any env file. The
> Postgres password reaches the container ONLY via the `db_password` secret file
> (`/run/secrets/db_password`). Adding `PGPASSWORD` in env would be a redundant
> secret-in-environment leak and defeats the purpose of Docker secrets.

## 4. Pin the digest in compose
- Edit `services/box/compose.yaml`, replace the `saga:` image placeholder
  `@sha256:0000…0000` with the digest from step 1. Commit + push.
- In the same edit, replace the `SAGA_PRINCIPAL_ID` value `U_BENDIK` with Bendik's
  real Slack user ID (format: `U01ABC…`). `U_BENDIK` is a placeholder — leaving it
  would silently set the wrong principal and break the confirm-gate ownership check.
- Pull the repo on the box (or copy the compose file across as the deploy flow does).

## 5. Prepare /srv/brain ownership for the non-root container
- The `saga` container runs as UID/GID 10001. Ensure it can write the working clone:
  `chown -R 10001:10001 /srv/brain` (or add an ACL). `/srv/network` stays root-owned, ro.
- Confirm `/srv/brain` has remote `origin` → `/srv/brain.git` (from `brain-init-remote.sh`).

## 6. Apply the egress allowlist — WITH a rollback safety net
nftables default-deny can lock you out. Apply behind a timed auto-revert:
- Copy `refresh-egress-allowlist.sh` to `/usr/local/bin/`, install the systemd
  unit + timer (`agent-box-egress.service`/`.timer`), `systemctl daemon-reload`.
- Schedule a rollback first: `sudo sh -c 'sleep 600 && nft flush ruleset' &` (or an
  `at` job) so a mistake self-heals in 10 min. Keep your SSH session OPEN.
- Apply: `nft -f services/box/ops/egress.nft` then run the refresh script once:
  `systemctl start agent-box-egress.service`.
- Verify from the box: gateway reachable (`curl -sS https://gw.owner.example/health` or a
  known endpoint), Slack reachable, and a *non*-allowed host (e.g. `curl https://example.com`)
  times out/drops. Verify your SSH/tailnet still works.
- When satisfied, cancel the rollback job and `systemctl enable --now nftables agent-box-egress.timer`.
- Persist the ruleset so it survives reboot (`/etc/nftables.conf` include or a systemd unit).

## 7. Flip the gate and run the live acceptance
- In `compose.yaml` set `saga` env `SAGA_LIVE: "1"`. (Or override via an env file.)
- `docker compose -f services/box/compose.yaml up -d saga`
- `docker compose logs -f saga` → expect "starting — connected to gateway, Slack…"
  then "listening for DMs on Slack".
- **Live containment acceptance:** DM Saga → ask for an action that writes →
  confirm she PROPOSES and waits → 👍 → she executes → check the `audit` table has
  a row for it → confirm a write attempt WITHOUT 👍 does nothing.
- Confirm a brain note she writes lands in `/srv/brain.git` (push-to-bare) and is
  picked up by the next backup snapshot.

## Rollback (full stop)
- `SAGA_LIVE=0` (or `docker compose stop saga` / `down saga`). The store is unaffected.
- The egress allowlist and image remain; only Saga stops.

---

## Post-cutover reality (verified live 2026-06-17 → 06-18)

The steps above were the *plan*. These are the things that actually bit, and the
shape the live system settled into. Trust this section where it conflicts above.

**Gateway URL.** The real value is `GATEWAY_URL=https://gateway.example.com/anthropic`
(NOT `gw.owner.example` — that host doesn't resolve). The model is pinned with
`ANTHROPIC_MODEL=claude-opus-4-8` (and `ANTHROPIC_SMALL_FAST_MODEL` the same, since
the gateway has no haiku-class route).

**Secret file permissions (the big one).** Non-Swarm `docker compose` does NOT copy
secret files to `0444` like Swarm does — it bind-mounts them preserving host perms.
Files created `0400 root:root` are therefore UNREADABLE by the non-root (10001)
container, and Saga crash-loops on a silent secret read. Fix on the box:
`chgrp saga /etc/agent-box/*  &&  chmod 0440 /etc/agent-box/*`. Also: the compose
`secrets:` names MUST be hyphenated (`gateway-key`, `slack-app-token`, …) to match
the `/run/secrets/<name>` paths `bin/saga.ts` reads.

**/srv group-perms recipe.** `/srv/brain` + `/srv/brain.git` are `root:saga 2775`
(setgid) with `git config core.sharedRepository=group`; `/srv/network` +
`network.db` are `root:saga`, group-readable. The non-root container reads/writes
via the `saga` group, not by owning the files.

**git for the non-root brain writer.** Two non-obvious requirements: (1) mount the
*bare* repo at the SAME absolute path the clone's origin uses (`/srv/brain.git`),
so push-to-bare resolves; (2) git ignores `safe.directory` set via env — it must be
in a real gitconfig, so mount `/srv/agent/gitconfig:/etc/gitconfig:ro` with
`safe.directory=*`. The daily network replica push must re-apply `chgrp 10001 +
0640` after its `mv`, or it silently drops the group-read (see `push-network-replica.sh`).

**Persona iteration without a rebuild.** `SAGA_PERSONA_FILE=/srv/agent/persona.md`
is mounted `ro`; edit it on the box + `docker compose up -d --force-recreate saga`
to reload, no image build. Bake the final persona into the image later.

**Conversational memory + restarts.** Memory is the Agent SDK session, persisted as
`sessions.sdk_session` and resumed per thread. The SDK keeps transcripts under
`HOME=/tmp` (tmpfs), so a container restart wipes them — a stored session id then
can't be resumed ("No conversation found"). The runtime now CATCHES that and
restarts the thread fresh (audit row `brain.resume — stale session`), so a restart
costs that thread its memory but never errors a turn. (Optional hardening for later:
point the SDK transcript dir at a persistent volume.)

**Liveness.** `bin/healthcheck.ts` (Docker healthcheck) checks a `heartbeat` table
row stays fresh; invoke `tsx` by its hoisted path `/app/node_modules/.bin/tsx` (NOT
`pnpm`, which re-triggers a corepack download and would need npm egress). Set
`HEALTHCHECKS_URL` in the saga env if you want external Healthchecks.io alerting.

**Rollback anchor.** Keep the last-known-good image digest recorded (in the deploy
ledger). If a new image misbehaves, repin that digest and
`docker compose up -d --force-recreate saga`. Per-deploy: clear stale sessions with
`UPDATE sessions SET sdk_session = NULL;` if you want a clean slate (the recovery
above also handles it lazily).

**Mac Saga is retired.** The old launchd Mac agent is stopped + disabled
(`co.heiberg.lares.saga`); do not re-enable it. Radar/digest/backup launchd agents
stay on the Mac.

**Egress firewall — APPLIED + LIVE (2026-06-18).** Domain-aware proxy + nft, not an IP
allow-list (Slack's AWS IPs rotate). Pieces: (1) `slack-proxy` squid service allow-lists
`*.slack.com`; Saga's `SAGA_SLACK_PROXY=http://slack-proxy:8888` routes all Slack traffic
through it. (2) Saga pinned to `172.18.0.10` (compose `ipv4_address`). (3) nft
`inet saga_egress` (`ops/egress-saga.nft` → `/opt/agent-box/proxy/egress.nft`) drops
Saga's direct internet, allowing only inter-container + `192.0.2.10` (gateway+Twenty) +
DNS; boot-persisted by `saga-egress.service`. gateway+Twenty go DIRECT (one stable IP).
Verified: open-internet BLOCKED, our services OPEN, Slack live via proxy.
**Rollback = `nft delete table inet saga_egress` (NEVER `nft flush ruleset`).** Scoping:
`docs/research/2026-06-18-saga-egress-domain-proxy-scoping.md`.

**GOTCHA — the firewall must allow EVERY cold-start dependency (2026-06-18 incident).**
The image CMD used to run `pnpm`→corepack, which downloads pnpm from npm at every cold
start. The firewall blocks npm → the FIRST recreate after the firewall crash-looped Saga
(latent until then, since the container hadn't restarted). Fixed by running the hoisted
`tsx` binary directly (Dockerfile CMD + compose `command:` both updated) — no npm at
startup. Lesson: anything Saga reaches at boot must be on the allow-list, and any NEW
outbound dependency must be added to the firewall AND restart-tested.

**Adding a new egress destination (e.g. Migadu email):** resolve its IPs and add an
`ip daddr <ip> accept` line to `egress-saga.nft` for Saga's subnet, reload, and force-
recreate Saga to confirm cold-start works. The email door is OFF until Migadu's IMAP/SMTP
(`imap.migadu.com` / `smtp.migadu.com`) IPs are allow-listed + the resilient client verified.

**Twenty note writes** are now ENABLED (confirm-gated): on Bendik's 👍, Saga POSTs a
real Note and links it to a person only on an unambiguous match. First live write should
be eyeballed in the CRM.

**Conversational memory survives restarts** (2026-06-18): `CLAUDE_CONFIG_DIR=
/srv/saga-state/claude` on a writable mount persists the SDK session transcripts
(verified: a fresh container recalled a codeword set by a prior one). The stale-session
recovery stays as a backstop. **Healthchecks.io** liveness ping is wired via
`HEALTHCHECKS_URL` in `/opt/agent-box/.env` (box-only, not in the repo).

**DB MIGRATIONS ARE A MANUAL DEPLOY STEP — the box has NO auto-migrate (2026-06-22).**
Pinning a new image + `docker compose up` does NOT apply `services/box/sql/*.sql`.
Any new migration must be run by hand against the live DB as part of the cutover, e.g.:
`docker compose exec -T db psql -U lares -d lares_state -c "<the ALTER…>"` (migrations are
written idempotent — `ADD COLUMN IF NOT EXISTS` etc. — so re-running is safe). The Saga
AI-SDK cutover missed `004_audit_principal.sql` and the new code crashed on the first
audited WRITE (`column "principal" of relation audit does not exist`) — reads didn't catch
it (reads aren't audited under the AI SDK brain). **So: (1) apply pending `sql/` migrations
before recreating; (2) verify a WRITE path post-cutover, not just a read.** Full write-up:
`docs/solutions/2026-06-22-agent-box-no-auto-migrate.md`. As of the AI-SDK cutover the live
brain runs `@sha256:05cdfdf9…` (CI `7e379d5`); rollback anchor `@sha256:ae14472e72bb…`.

**Saga's brain is now the Vercel AI SDK over the native Anthropic gateway path (2026-06-22).**
The `SdkBrain`/Claude-Agent-SDK is gone. Model comes from `agents/saga/agent.json`
(`claude-opus-4-8`), so `ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL` env are now inert
legacy. `bin/saga.ts` derives the brain URL from `GATEWAY_URL` (+`/v1`) — no new env. Headless
verification is `docker compose exec -T -e PROBE_MSG="…" saga /app/node_modules/.bin/tsx
services/agent-runtime/bin/saga-probe.ts` (NOT `docker compose run` — saga's fixed
`ipv4_address` makes `run` fail "Address already in use").
