# rc.12 release notes

rc.12 follows rc.11 (`releases/2026-10-19-rc.11.json`). It is the release that makes the install
Docker-only: a server needs Docker, `curl` and `python3`, and nothing else. This page is the short
version, written ahead of the release. **The full notes (what changed, upgrading from rc.11 and the
security scan) come with the release.** Only the section below is final.

Installing, updating and rolling back with `get-lares.sh` and the `lares` command works for rc.12
and later only. rc.11 and earlier do not carry the files it needs.

## Switching a server installed before rc.12

This is for a server that was installed from a copy of the repository (rc.11 or earlier). You do
this once. After it, you use `lares update` and `lares rollback` and never touch that copy again.
A new server needs none of this: follow [the install guide](../install.md).

Before you start:

1. **Have a fresh, proven backup.** Open the console's Backup page: it should read Protected. To
   take and check one now, as root: `systemctl start lares-backup.service`, wait for it to finish,
   then `systemctl start lares-backup-verify.service`. The switch below does not take a backup of
   its own.
2. **Know the release name.** It is the full file name, without `.json`, of the rc.12 file in the
   [`releases/`](https://github.com/Heiberg-Industries/lares/tree/main/releases) folder. It looks
   like `2026-10-19-rc.11`: the date, then `rc.` and a number. Use the rc.12 one (the example
   shows only the shape). A short name such as `rc.12` is refused.

The switch, as root on the server:

1. Download the script and read it:

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/Heiberg-Industries/lares/main/services/box/ops/get-lares.sh
   ```

2. Check first. This changes nothing under `/etc`, `/srv` or `/opt/lares`, and prints every problem
   in one pass:

   ```bash
   bash get-lares.sh --release <release-name> --dry-run
   ```

3. Run it for real. It pulls the engine image by digest, unpacks the scripts into
   `/opt/lares/releases/<release-name>/`, runs the installer in repair mode over your existing
   installation (your answers, secrets and agents are kept; an existing `/srv/lares` makes it an
   update, not a fresh start), and only if that worked points `/opt/lares/current` at the release
   and installs the `lares` command:

   ```bash
   bash get-lares.sh --release <release-name>
   ```

4. Check the server: `lares doctor`, then open the console and send one chat message to an agent.
5. Refresh the backup scripts. Backups were switched on with the old copies of the scripts, and
   they are still the old ones. Run `lares backups --yes`: it reuses your saved answers, copies the
   new scripts and units into place, and runs a backup, a restore rehearsal and the check once.
   Then confirm the Backup page reads Protected.

If a step stops, read what it printed; running the same command again is safe and a failed
download or image pull changes nothing. The old copy of the repository on the server is not used
by anything from here on.

**Going back.** The switch is not recorded as an update, so `lares rollback` cannot undo it (there
is no `previous` release yet). To go back past it, restore the backup you took before.

From then on:

- `lares update --release <release-name>` moves to a new release. If it says the backup scripts
  are older than the release's, run `lares backups --yes` to refresh them.
- `lares rollback` goes back **one level only**, to the release called `previous`.
