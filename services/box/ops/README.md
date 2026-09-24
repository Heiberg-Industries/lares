# agent-box/ops — Backup & DR machinery (Stage 1.5)

Version-controlled scripts for the box's backup/disaster-recovery (Stage 1.5
[plan](../../../docs/superpowers/plans/2026-06-16-agent-box-stage1.5-backup-dr.md)).
They are **copied to** their machines and run there — kept here so they are reviewable
and survivable, not pasted ad-hoc.

## The shape

```
restic snapshot (encrypted, dedup)
  box  ──append-only──▶  Hetzner Storage Box (different region)   ← nightly, from the box
  Mac  ──copy────────▶  Scaleway Object Storage (versioned)       ← weekly, off-provider
  Mac  ──prune────────▶  Hetzner Storage Box (non-append key)     ← weekly retention
  Mac  ──git pull─────▶  Brain working clone                      ← every 30–60 min (Stage 3)
```

Append-only means a compromised box can *add* snapshots but cannot *delete/overwrite*
them. Deleting (prune) is therefore done only from the Mac, with a **second, non-append
key**. Encryption is restic's, independent of LUKS — a backup is safe even if the
Storage Box itself is read.

## Files

| File | Lives on | As |
|---|---|---|
| `backup.sh` | box | `/opt/agent-box/backup.sh` (0750 root) |
| `backup.env.example` | box | `/etc/agent-box/backup.env` (0400 root) — fill the real values |
| `agent-box-backup.service` / `.timer` | box | `/etc/systemd/system/` — `systemctl enable --now agent-box-backup.timer` |
| `backup-verify.sh` | box | `/opt/agent-box/backup-verify.sh` (0750 root) — the SINGLE liveness owner: asks the repository whether a fresh snapshot is in it, and pings healthchecks.io only then |
| `agent-box-backup-verify.service` / `.timer` | box | `/etc/systemd/system/` — `systemctl enable --now agent-box-backup-verify.timer` |
| `mirror-and-prune.sh` | Mac | `~/.lares/mirror-and-prune.sh`, weekly via launchd |
| `mirror.env.example` | Mac | `~/.lares/mirror.env` (0400) — fill the real values |
| `brain-init-remote.sh` | box | run once to create `/srv/brain.git` (bare) + `/srv/brain` (working clone); idempotent |
| `note-lock.sh` | box | deployed as `/srv/brain/.note-lock.sh`; serialises concurrent agent writes to the same note |
| `brain-push.sh` | Mac | lives at `~/Developer/brain/.brain-push.sh`; commit + push wrapper for human edits |
| `push-network-replica.sh` | Mac | run by the daily `co.heiberg.lares.network-backup` launchd job (09:30); Mac-side privacy gate — exports stripped replica, runs `verifyNoRawContent`, FAILS CLOSED before rsync if any `interactions.content` is non-NULL; pushes over Tailscale SSH to `/srv/network/network.db` |
| `input-freshness.sh` | box + Mac | box: `/usr/local/bin/input-freshness.sh` with `.service`/`.timer` (hourly) and `/etc/input-freshness.env`; Mac: `~/.lares/input-freshness.sh`, called at the end of `network-ingest.sh`. Checks the INPUTS other jobs read, not those jobs' success lines; ORB-175: one heartbeat row per eve-saga schedule (section 5b) |
| `input-freshness.service` / `.timer` / `.env.example` | box | `/etc/systemd/system/` + `/etc/input-freshness.env` — `systemctl enable --now input-freshness.timer` |
| `disk-guard.sh` + `.service` / `.timer` / `.env.example` | box + ops-1 | `/usr/local/bin/disk-guard.sh`, every 10 min, pushes root-disk usage to Uptime Kuma |
| `network-ingest.sh` | Mac | `~/.lares/bin/network-ingest.sh`, launchd `co.heiberg.lares.network-backup` 09:30 — daily Contacts/Messages import and everything downstream of it |
| `verify-network-replica.sh` | box | future hardening — **NOT YET ACTIVE**; box-side containerised verifier (needs CI-built linux `better-sqlite3` + pinned Node image); fails closed if prerequisites absent; Mac gate (`push-network-replica.sh`) is the live gate |

The restic repo password (the single most important secret — lose it and every backup
is unrecoverable noise) lives in **two** vaults (Apple Passwords + Vaultwarden) and as a
root-only `/run/secrets/restic-password` on the box / `~/.lares/secrets/restic-password`
on the Mac.

## Two keys on the Storage Box (don't skip this)

The Storage Box `authorized_keys` gets **two** lines:

```
# box's key — APPEND-ONLY (can back up, cannot delete):
command="rclone serve restic --stdio --append-only box-backup",restrict ssh-ed25519 AAAA...box
# Mac's key — full (for weekly prune only):
command="rclone serve restic --stdio box-backup",restrict ssh-ed25519 AAAA...mac
```

## The alerting these hang off

Every guard here is only as good as the thing listening on the other end, and for most of
August 2026 nothing was — see **[docs/runbooks/box-alerting.md](../../../docs/runbooks/box-alerting.md)**
for the map of what watches what, what a red means for each check, and the interval rule
that keeps Kuma's push monitors from crying wolf. Read that before creating or editing any
push monitor.

## Verify it's real

A backup you haven't restored is not a backup. The monthly drill and quarterly
full-runbook restore are in the Stage 1.5 plan (Task 8) and the
[restore runbook](../../../docs/runbooks/agent-box-restore.md).

## The market feed's tables

The three `tyche_*` tables (Saga's `market-edge` skill, the `market-refresh` schedule and the
console's `/markets` page read and write them) are owned by
[`../sql/037_tyche.sql`](../sql/037_tyche.sql) (LAR-32). Like every file in `../sql/` it is
hand-applied, idempotent and its number is never reused; on a box that already has the tables
it is a no-op, and a later column or index ships as its own numbered file.
