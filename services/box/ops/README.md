# services/box/ops — install, update and backup scripts

Version-controlled scripts and systemd units for a Lares box. They are copied to the box and
run there; they live here so they can be reviewed.

## Install and lifecycle

| File | What it does |
|---|---|
| `install.sh` | First install and re-runs: preflight, secrets, database, keeper, stack, first owner |
| `update.sh` | Move the box to a released version (images pulled by digest, never built on the box) |
| `rollback.sh` | Return to the previous recorded version |
| `restore.sh` | Restore an installation from a nightly restic snapshot onto a fresh install (`--snapshot <id\|latest>`, `--dry-run`) |
| `export.sh` | Export an installation's data as an archive, without secrets |
| `vault-purge.sh` | Erase named material from the vault, with an audit record |
| `Caddyfile` | Reverse-proxy example for the console |
| `egress.nft`, `refresh-egress-allowlist.sh` | Default-deny outbound firewall for the agent containers, and the timer script that keeps its allow-set current |
| `signal-catalogue.seed.json`, `signal-routes.seed.json` | Seed rows for the console's signal catalogue and routes |
| `configure-google-keeper.py` | Writes Google connection settings into the keeper |
| `rotate-restored-gateway-key.py` | Repairs a model-gateway key after a restore when the agent's key file is missing (`restore.sh` prints when) |
| `note-lock.sh` | Serialises concurrent writes to the same vault note |

**Before updating to rc.6:** the console refuses to start without `CONSOLE_SESSION_SECRET_FILE`,
the path of a file holding its session secret. `install.sh` creates `console-session-secret` and
the generated compose sets the variable. A hand-written console compose must mount that file and
set the variable before you update, and if it interpolates `${...}` values it must be started
with `--env-file`. Details: [`docs/releases/rc.6-notes.md`](../../../docs/releases/rc.6-notes.md).

## Backups

```
restic snapshot (encrypted, deduplicated)
  box ──nightly──▶ an off-box restic repository
                   (an SSH host, an S3-compatible bucket, or a second disk)
```

To switch all of this on and prove it once, run `install.sh --backups` (it hands over to
`setup-backups.sh`; `docs/install.md` section 9 explains what it asks).

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
| `disk-guard.sh` + `.service` / `.timer` / `.env.example` | `/usr/local/bin/`, `/etc/disk-guard.env` | Every 10 minutes, pushes root-disk usage to a push-style uptime monitor |

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
