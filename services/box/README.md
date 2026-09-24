# @lares/agent-box

The private agent box's **state store** — Postgres 16 + pgvector + pg-boss — and a
small typed data layer over it. This is Stage 2 of the agent-box build
([spec](../../docs/superpowers/specs/2026-06-16-agent-box-knowledge-store-design.md),
[plan](../../docs/superpowers/plans/2026-06-16-agent-box-stage2-postgres.md)).

It deploys to `lares-agent-1` and **runs** there — it is never built on the box
(`docker build` / `pnpm install` on an 8 GB box risks an OOM). Images are
digest-pinned and pulled; the Node code is small enough to ship as source.

## What's in here

| File | What it is |
|---|---|
| `sql/001_init.sql` | The state schema: `sessions`, `confirmations`, `reminders`, `trigger_schedules`, `audit`, plus the `vector` + `pgcrypto` extensions. Applied automatically on the DB's first init. |
| `compose.yaml` | One `db` service (`pgvector/pgvector:pg16`, digest-pinned). **No published port** — Postgres is reachable only on the internal Compose network. Password injected via a Docker secret file. |
| `.env.example` | Non-secret connection config (`PGHOST` etc.). Copy to `.env` (gitignored). The DB password is never an env value. |
| `lib/db.ts` | Pool helpers. Reads the password from `DATABASE_PASSWORD_FILE` (default `/run/secrets/database-password`), falling back to `/run/secrets/db_password` for one older installation, then to `PGPASSWORD` for local use. |
| `lib/reminders.ts` | Typed reminders data layer (`createReminder`, `dueReminders`, `markDelivered`) — closes Saga's reminder gap. The Stage 3 daemon consumes it. |
| `lib/boss.ts` | pg-boss bootstrap (the Postgres-native job queue; no Redis). |
| `migrate.ts` | Manual first-apply runner for the SQL (the Compose init mount is the normal path). |
| `tests/` | Vitest tests that spin up a real `pgvector:pg16` container (Testcontainers), apply the real schema, and verify the data layer + the `pgboss` schema. No mocks. |

## Develop / test (on the Mac)

```bash
pnpm --filter @lares/agent-box test       # spins ephemeral Postgres containers; needs Docker running
pnpm --filter @lares/agent-box typecheck
```

## Deploy to the box (Stage 2 box-side — NOT done yet)

These steps run on `lares-agent-1` and are **deliberately deferred until Stage 1.5
(Backup & DR) is green**, so the moment any data lands it is already backed up.

1. **Pin the secret.** Generate a DB password and place it root-only (not a
   world-readable `.env`) so a contained agent can't read it:
   ```bash
   umask 077
   openssl rand -base64 32 > /run/secrets/agent-box-db-password   # tmpfs, root:root 0400
   ```
   For persistence across reboot, store it in the password manager and
   re-materialise on boot via a systemd unit using `LoadCredentialEncrypted=`.
   Migrate here when Vaultwarden is deployed.
2. **Bring up Postgres** (compose + sql shipped to `/opt/agent-box`, pulled — never built):
   ```bash
   cd /opt/agent-box && docker compose up -d
   ```
3. **Verify** the five tables + `vector` exist, and that Postgres is **not** reachable
   from outside the box (no published port).
4. **Confirm the backup captures it** — re-run the Stage 1.5 `backup.sh` and check a
   DB dump is in the snapshot.

## Notes carried from the 2026-06-16 pre-build audit

- Secrets via systemd-creds / Docker secret file — never a world-readable `.env`.
- The box runs **pinned prebuilt images only**; never `docker build` / `pnpm install` on the box.
- The `audit` table is **append-only** (the agent role gets INSERT + SELECT only,
  granted at deploy time) and shipped off-box.
- Postgres is bound to the **internal Compose network only**.
