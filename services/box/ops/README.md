# services/box/ops — install, update and backup scripts

Version-controlled scripts and systemd units for a Lares box. They live here so they can be
reviewed. On a server they arrive inside the engine image: `get-lares.sh` (the one file you
download) unpacks them to `/opt/lares/releases/<name>/services/box/ops/`, and the `lares` command
runs them from there. This works for rc.12 and later.

## Install and lifecycle

| File | What it does |
|---|---|
| `get-lares.sh` | The one file you download: fetches a named release, pulls its engine image by digest, unpacks the scripts, runs `install.sh`, then switches `current` and installs `lares` |
| `lares` | The command installed in `/usr/local/bin`: `lares update`, `rollback`, `restore`, `doctor`, `backups` |
| `install.sh` | First install and re-runs: preflight, secrets, database, keeper, stack, first owner |
| `update.sh` | Move the box to a released version (images pulled by digest, never built on the box). Run it through `lares update` |
| `rollback.sh` | Put the previous images back, one step only (see below). Run it through `lares rollback` |
| `restore.sh` | Restore an installation from a nightly restic snapshot onto a fresh install (`--snapshot <id\|latest>`, `--dry-run`). Run it through `lares restore` |
| `unpack-engine.sh`, `engine-run.sh` | Inside `get-lares.sh` and the other scripts: unpack the files out of the engine image, and run one of the box's programs in a throwaway container of it |
| `export.sh` | Export an installation's data as an archive, without secrets |
| `vault-purge.sh` | Erase named material from the vault, with an audit record |
| `Caddyfile` | Reverse-proxy example for the console |
| `egress.nft`, `refresh-egress-allowlist.sh` | Default-deny outbound firewall for the agent containers, and the timer script that keeps its allow-set current |
| `signal-catalogue.seed.json`, `signal-routes.seed.json` | Seed rows for the console's signal catalogue and routes |
| `configure-google-keeper.py` | Writes Google connection settings into the keeper |
| `rotate-restored-gateway-key.py` | Repairs a model-gateway key after a restore when the agent's key file is missing (`restore.sh` prints when) |
| `note-lock.sh` | Serialises concurrent writes to the same vault note |

## Where things live

`get-lares.sh` unpacks each release to `/opt/lares/releases/<name>/`. `/opt/lares/current` links
to the release in use, and `/usr/local/bin/lares` points through it. `/opt/lares/previous` links to
the release before the last `lares update`; there is one level and no more. A release name is the
release file's full name without `.json`, for example `2026-10-19-rc.11`.

**Before updating to rc.6:** the console refuses to start without `CONSOLE_SESSION_SECRET_FILE`,
the path of a file holding its session secret. `install.sh` creates `console-session-secret` and
the generated compose sets the variable. A hand-written console compose must mount that file and
set the variable before you update, and if it interpolates `${...}` values it must be started
with `--env-file`. Details: [`docs/releases/rc.6-notes.md`](../../../docs/releases/rc.6-notes.md).

## Rolling back an update

`lares rollback [--dry-run] [--yes]` (it runs `rollback.sh`, then points `current` back at
`previous`) reads the record `update.sh` wrote, says what it would put back
and what it would not, asks, then writes the previous image digests into the installation's
compose file, pulls them and starts them. It goes back exactly one step, to `previous`; once that record says
"rolled-back" it refuses to run again. **It does not undo database changes**: it runs no migration
in either direction, and it names the backup `update.sh` took before the update. To go back past
a migration, restore that backup
([restore onto a new server](../../../docs/install.md#restoring-onto-a-new-server)). If the keeper
renders an agent's compose file from its own configuration, change that configuration too, or the
keeper puts its configured image back the next time it applies the agent.

## Health check

`lares doctor` is a read-only check of the installation's settings,
database, migrations, owner, backup record, open repairs and gateway. See
[`services/box/README.md`](../README.md#lares-doctor).

## Backups

```
restic snapshot (encrypted, deduplicated)
  box ──nightly──▶ an off-box restic repository
                   (an SSH host, an S3-compatible bucket, or a second disk)
```

To switch all of this on and prove it once, run `lares backups` (it runs `setup-backups.sh`;
`docs/install.md` section 9 explains what it asks). `install.sh --backups` hands over to the same
script. The backup scripts are copied to `/opt/lares` and an update does not replace them. `lares update` prints which copies
are out of date; then run `lares backups --yes` to refresh them.

The target is chosen at install time. Any repository restic supports works; the examples in
`backup.env.example` use placeholder hosts. Prefer a target that is append-only for the box's
key, so a compromised box can add snapshots but not delete history. Encryption is restic's
own, independent of disk encryption.

| File | Lives on the box as | Notes |
|---|---|---|
| `backup.sh` | `/opt/lares/backup.sh` (0750 root) | Nightly snapshot of database dumps, vault and config |
| `backup.env.example` | `/etc/lares/backup.env` (0400 root) | Fill in real values; no secrets belong in it |
| `lares-backup.service` / `.timer` | `/etc/systemd/system/` | `systemctl enable --now lares-backup.timer` |
| `backup-verify.sh` | `/opt/lares/backup-verify.sh` (0750 root) | Reads a fresh snapshot back out of the repository, then pings the heartbeat URL. The only liveness owner |
| `lares-backup-verify.service` / `.timer` | `/etc/systemd/system/` | `systemctl enable --now lares-backup-verify.timer` |
| `restore-drill.sh` | `/opt/lares/restore-drill.sh` (0750 root) | Monthly: restores a snapshot into scratch space and checks it |
| `lares-restore-drill.service` / `.timer` | `/etc/systemd/system/` | `systemctl enable --now lares-restore-drill.timer` |
| `disk-guard.sh` + `.service` / `.timer` / `.env.example` | `/usr/local/bin/`, `/etc/disk-guard.env` | Optional; `install.sh` does not install it (see below) |

### Disk guard (optional)

`disk-guard.sh` checks how full the root disk is every 10 minutes and pushes the result to a
"push" monitor in an uptime tool you run (the script is written for Uptime Kuma). Under the
threshold (default 75 percent) it reports up; at or over it reports down, which fires that tool's
own notification, and if the box stops pushing at all the missed heartbeat alerts you. It is not
installed by `install.sh` and nothing in the console reads it. To use it: copy the script to
`/usr/local/bin/`, the `.service` and `.timer` to `/etc/systemd/system/`, create the monitor,
put its push URL in `/etc/disk-guard.env` as `KUMA_PUSH_URL` (mode 0600; `THRESHOLD` and `MOUNT`
are optional), and enable `disk-guard.timer`. Set the monitor's heartbeat and retry intervals to
at least twice the timer's period (1500 seconds for the 10-minute timer), or the monitor flaps.

The restic repository password is the most important secret: lose it and every backup is
unrecoverable. Keep it in a root-only file on the box (`RESTIC_PASSWORD_FILE`) and in at least
one password manager off the box.

### Append-only SSH targets

For an SSH target, give the box a key that is restricted to an append-only restic server, and
keep any pruning key off the box:

```
# the box's key: can back up, cannot delete
command="rclone serve restic --stdio --append-only box-backup",restrict ssh-ed25519 AAAA...box
# an admin machine's key: full access, used only for pruning
command="rclone serve restic --stdio box-backup",restrict ssh-ed25519 AAAA...admin
```

## Verify it is real

A backup you have not restored is not a backup. `restore-drill.sh` runs monthly and
`backup-verify.sh` raises an alarm when no drill has passed recently. Run the drill by hand
once after install and read what it says.
