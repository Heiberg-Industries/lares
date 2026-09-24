# Declarative integration wiring — box reconcile (2026-06-26)

Phase 4 of the declarative-integration-wiring plan
(`docs/superpowers/plans/2026-06-26-declarative-integration-wiring.md`).
Code (Phases 1-3) is on `main` (range `fa2be328..54ed586c`); the runtime now
builds each agent's hands from its `agent.json` grants via `buildAgentHands`,
and `pnpm lares gen-compose` emits per-agent least-privilege compose fragments
(`services/agent-runtime/agents/<a>/<a>.compose.gen.yaml`).

## What changed on the live box (`/opt/agent-box`, edited in place)

The generated fragments were NOT overlaid wholesale — they emit empty
`configEnv` defaults for best-effort URLs (`ORAKEL_URL`, `READABILITY_URL`,
`GOOGLE_REDIRECT_URI`), which would have clobbered the box's real values. Only
the genuine, additive deltas were hand-merged:

- **Saga** (`compose.yaml`): Orakel hand ENABLED (was inert — no `ORAKEL_URL`).
  - env: `ORAKEL_URL: https://service.example`, `ORAKEL_KEY_FILE: /run/secrets/orakel-key`
  - service `secrets:` += `orakel-key`; top-level `secrets:` += `orakel-key` → `file: /etc/agent-box/orakel-key`
  - **Recreated** (`docker compose up -d --no-deps saga`) — healthy, listening for DMs, no secret/wiring errors.
- **Nora** (`compose.override.yaml`): env += `TWENTY_BASE_URL: https://crm.owner.example`
  (the registry renamed `TWENTY_URL` → `TWENTY_BASE_URL`). `TWENTY_URL` LEFT in
  place — the currently-pinned image still reads it. **NOT recreated** — the new
  var only matters to the new image; it activates at the image re-pin.
- **Calliope**: no change (env already had `STUDIO_MODEL` + `ATLAS_PATH`; the
  studio integration declares no integration secret).

Backups: `/opt/agent-box/compose.yaml.bak.pre-declarative-20260626-1507` and
`compose.override.yaml.bak.pre-declarative-20260626-1507`.

## DONE — image re-pin (the cutover; 2026-06-26, supervised)

All five agent-runtime services re-pinned to the new declarative CI build
**`sha256:d9f8518cc56f54b7f16b4589c1967b309331f47fe3dda9291432d682b6f88255`**
(commit `54ed586c`, CI run 28239266421) and recreated one at a time, all clean:
- **saga** — healthy, "listening for DMs", loops armed, Orakel live (new image + URL + key).
- **saga-digest, saga-dream** — Up, no errors.
- **calliope** — "listening for briefs", atlas+studio hands built via buildAgentHands.
- **nora** — "workflow-runner: service up … ticks every 5000ms"; gmail OAuth resolved at boot (no "not enrolled"); new image reads `TWENTY_BASE_URL`.
- **tyche** — UNTOUCHED (`sha256:5057e2ae…`); console untouched.

The declarative "hands from grants" code is now LIVE on the box.
Rollback anchors (prior images): saga-family `sha256:74ae7dece2ea…`, nora
`sha256:9574c453…`. Fresh backups: `compose{,.override}.yaml.bak.pre-repin-20260626-1515`.

**Tidy-up still open (non-urgent):** Nora's now-dead `TWENTY_URL` env can be
dropped from `compose.override.yaml` (the live image reads `TWENTY_BASE_URL`);
left in place as a harmless no-op + rollback safety.

**Acceptance (Bendik):** DM Calliope a brief; confirm a Nora outreach round-trip.
(Saga's Orakel verified working live — see egress fix below.)

## Egress fix — Saga's Orakel hand (2026-06-26, authorized)

Enabling Saga's Orakel hand surfaced a SEPARATE blocker: Saga runs in a sealed
container with a default-deny egress allow-list (`inet saga_egress` nftables
table; filters saga `.10` / saga-digest `.11` / calliope `.13`). `service.example`
(198.51.100.10) was not allow-listed, so every call was dropped at the firewall
and the best-effort Orakel hand degraded silently to "not found" — which looked
exactly like an Orakel outage (it was NOT; Orakel returns HTTP 200 with full
data from anywhere that can reach it). Nora (`.14`) is not egress-filtered, which
is why her Orakel worked but Saga's didn't.

Fix: added `ip daddr 198.51.100.10 accept` to `/opt/agent-box/proxy/egress.nft`
(mirroring the readability/gateway allow) + atomic reload (`nft -f`). Verified
from INSIDE saga's container: `GET /api/companies/998933609` → HTTP 200
(DITT GRAFISK AS); open internet (1.1.1.1) still BLOCKED (containment intact).
Backup: `egress.nft.bak.pre-orakel-*`. Rollback: remove the line + `nft -f`.

**General lesson:** `gen-compose` owns integration env + secrets, NOT egress.
Enabling an OUTBOUND integration for a sealed/egress-filtered agent ALWAYS needs
a matching manual egress allow (stable origin IP, or proxy for rotating CDNs).

## Rollback

Restore the `.bak.pre-declarative-20260626-1507` files and
`docker compose up -d --no-deps saga` (and nora if it had been recreated).

## Verify Saga's Orakel (manual)

DM Saga a company-research prompt that needs Orakel (e.g. "look up <company>
org/financials"). NOTE: full Orakel-hand behaviour is only guaranteed on the new
image; the env+key are staged on the current image now.
