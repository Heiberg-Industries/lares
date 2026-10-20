# @lares/agent-box

The installation's **state store** and the commands that install and look after it. It holds the
Postgres schema (PostgreSQL 16 with pgvector), a small typed data layer over it, the stack
renderer the installer uses, and the install, update, backup and restore scripts under `ops/`.

You do not deploy this package by hand. A server is installed by downloading one script,
`ops/get-lares.sh`, and running it with a release name. It pulls the release's engine image by
digest, unpacks the installer from it and runs `ops/install.sh`, which renders the stack from the
release file and pulls every image by digest. Nothing is built on the server, and the server needs
no Node.js, no pnpm and no copy of this repository. The step-by-step guide is
[`docs/install.md`](../../docs/install.md), and `ops/README.md` describes the scripts. This works
for rc.12 and later.

## What is in here

| Path | What it is |
|---|---|
| `sql/` | The schema. `001_baseline.sql` is the whole base schema (sessions, confirmations, reminders, schedules, the audit record, the agent, keeper and console tables, the identity register, plus the `vector` and `pgcrypto` extensions). Later changes are new files numbered above 001 (`002_…`, `003_…`, `004_…`), applied in order. |
| `migrate.ts` | The migration runner: `pnpm -C services/box migrate` applies any file not yet recorded, and says when there is nothing to do. The installer and `ops/update.sh` run it; there are no down migrations. |
| `lib/` | The data layer: database pool (`db.ts`), sessions, confirmations, reminders, the audit record, token encryption (`crypto.ts`, `oauth-tokens.ts`), the migration ledger, the stack renderer (`stack-compose.ts`), the release-file reader (`release-manifest.ts`), and the person export and erasure code. |
| `bin/` | The commands the installer and the owner run (below). |
| `ops/` | The install, update, rollback, backup, restore and export scripts and their systemd units. See [`ops/README.md`](ops/README.md). |
| `proxy/squid.conf` | The egress proxy's configuration: outbound traffic from agents goes through an allow-list. |
| `compose.lares-keeper.yaml` | The keeper and egress proxy, as rendered into `/opt/lares/compose.lares-keeper.yaml`. |
| `tests/` | Vitest tests that start real `pgvector` containers (Testcontainers), apply the real schema and check the data layer. Docker must be running. |

The stack Compose file (database, console, gateway, Caddy) is not a file in this folder. The
installer renders it from the release file with `bin/render-stack.ts` into
`/opt/lares/compose.yaml`.

## The commands

These are the programs inside the engine image. On a server you do not type these `pnpm` lines:
the installer and the `lares` command run them for you in a short-lived container (`lares doctor`
is the one you run yourself). The lines are the form for a developer working in a checkout of this
repository. Each takes `--help` or documents itself in its file header.

| Command | What it does |
|---|---|
| `pnpm -C services/box migrate` | Create or update the database schema. |
| `pnpm -C services/box doctor` | `lares doctor`: read-only health check; see below. |
| `pnpm -C services/box first-owner` | Make the owner a real member of the installation. A practice run unless `--apply`. |
| `pnpm -C services/box first-organisation` | Enrol the installation's first organisation (the owner's domain). Safe to repeat. |
| `pnpm -C services/box installation-settings` | Write the two settings the first-agent page needs (model alias prefix, agent ceiling) if they are missing; never overwrites. |
| `pnpm -C services/box render-stack` | Render `/opt/lares/compose.yaml` from a release file. |
| `pnpm -C services/box render-keeper-config` | Render `/etc/lares/keeper.json` from a release file. |
| `pnpm -C services/box export-person -- <who> --out <dir>` | Export what the installation holds about one member. Read-only. |
| `pnpm -C services/box erase-person -- <who>` | Erase one person. A practice run unless `--apply`. See [erasing a person](../../docs/how-to/erasing-a-person.md). |

### `lares doctor`

```bash
lares doctor
```

(In a developer checkout the same program is `pnpm -C services/box doctor`, with `PGHOST` and
`DATABASE_PASSWORD_FILE` set.) On a server, `lares doctor` runs it in the current release's engine
image, so any `--key-file` you give must be inside `/etc/lares/secrets/`.

It reads the installation's settings and database and prints, in plain sentences, what is wrong
and what to type to fix it: the settings list, the database, the migrations, the owner, the backup
record, open repairs, and the gateway. It changes no setting, no file and no row. It makes no
network call unless you add `--test-model --gateway <url> --alias <name> --key-file <path>`, which
sends one tiny, paid completion through your own gateway. Exit code 0 means nothing failed (a
warning alone still exits 0); 1 means at least one check failed.

## Develop and test

```bash
pnpm -C services/box test         # starts disposable Postgres containers; Docker must be running
pnpm -C services/box typecheck
```

The image probe in CI applies every file in `sql/`, in number order, to an empty pgvector
database. A new migration must run there; see the repository's `AGENTS.md`.
