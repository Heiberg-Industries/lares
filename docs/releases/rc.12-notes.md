# rc.12 release notes

rc.12 follows rc.11 (`releases/2026-10-19-rc.11.json`) and is recorded in
`releases/2026-10-21-rc.12.json`. It makes the install Docker-only: a server needs Docker, `curl`
and `python3`, and nothing else; `get-lares.sh` and the `lares` command install, update and roll
back from the engine image. It also changes how approval cards behave, pages long reads, and
removes internal planning history from the source. It adds two database files
(`services/box/sql/005_model_steps.sql`, `006_approval_session.sql`). The database image, the
gateway and the proxy in front of the console are the same as in rc.11. The keeper, console, sync
jobs, firewall helper, egress proxy and both agent images were rebuilt from the new source.

## What changed

### Install, update and rollback

- **Docker-only install.** `get-lares.sh --release <name>` pulls the release's engine image by
  digest, unpacks the installer into `/opt/lares/releases/<name>/`, runs it, and only then points
  `/opt/lares/current` at the release and installs the `lares` command. The installer's own
  programs run inside the engine image, not on the host.
- **`lares update`, `lares rollback`, `lares restore`** run from the engine image too. `lares
  update` also re-runs the installer in repair mode, so the keeper is updated with the rest.
  `lares rollback` goes back one level, to the release called `previous`.
- **`lares update --dry-run`** no longer installs the new release (it did in an early build of this
  release).
- **The keeper image is the engine image.** It carries the box tooling and can unpack the engine
  files.

### Approval cards

- **Typing "approve" in chat no longer approves a tool card.** Only the button, or the console,
  approves.
- **A revised draft withdraws the older card.** When the agent revises a draft in a later turn, with
  the same tool and the same target, the earlier card is withdrawn (eve shows "Cancelled"). On
  Telegram the withdrawn card says it was replaced by a revised version; the console lists only the
  card still waiting.
- **The assistants are told how to handle a waiting card** (one line in their instructions).

### Mail and drafts

- **Mailing-list mail ends as FYI before any model call**, and no draft is ever written to an
  unsubscribe address.
- **Drafts may suggest next steps**; they still never promise dates, money, bookings or
  deliverables.
- **Replies learn first from the owner's own mail to the same person**, and the writer card is
  distilled on what the writer is for.
- **The mail's sender, subject and body**, and the brief's meetings, obligations and picks, reach
  the model inside flagged blocks, so text in them is read as data, not instructions.
- **CRM routing ignores the owner's own signature** and asks instead of stopping.
- **CRM people lookup finds people by any part of their name** and tolerates accents.

### Reading long things

- Long notes, e-mails, web pages and PDFs come back to the agent one page at a time (12,000
  characters per page, with paging). A PDF that was cut says so.

### Console

- **Agent limit in Settings.** The administrator can change how many agents the server may run
  (up to 50), with the memory estimate shown beside it.
- **Waiting on you lists every pending proposal**, even when no agent is running. A stale proposal
  is pinged after 4 hours (was 24) and the ping names the Waiting page.
- **An agent's page shows how often the prompt cache is hit**, from token counts each model call
  now records on the server (`005_model_steps.sql`). Nothing leaves the server.
- The approval card for a shared-notes proposal says "Shared notes proposal".

### One owner per agent

- The first member to connect any door to an agent owns it. A second member's door claim is
  refused. Where two claims already exist, the earliest is the approver; nothing is removed
  automatically.

### Source and documentation

- Internal planning history is gone from comments, test names and decision records; text the
  model reads calls the owner "the owner" and uses the Vault's names (private area, shared area).
  Tests use Europe/Berlin as the example home zone.
- The installation file uses the real door secret names; the travel-era entries are gone. Platform
  and door secrets are declared in one place.
- Install guide for coding agents (`docs/install-with-an-agent.md`), and the install guide covers
  the Docker-only install, update and rollback.

## Upgrading from rc.11

A server installed from a copy of the repository switches once, as described in the section
below. That switch is also the upgrade: it applies `005_model_steps.sql` and
`006_approval_session.sql` (safe to run twice; a rollback does not undo them). From rc.10 the same
switch also applies rc.11's `004_web_inbox.sql`, and the rc.11 Notion setting applies
(`NOTION_MEETINGS_DATA_SOURCE_ID`, see [the rc.11 notes](rc.11-notes.md#upgrading-from-rc10)).
Nothing else to change for backups (beyond `lares backups --yes` after the switch), settings or the
keeper's configuration.

Check: `lares doctor` passes; an agent's page shows the cache hit rate after a few messages;
typing "approve" beside a waiting card does not approve it; the Backup page reads Protected.

## Switching a server installed before rc.12

This is for a server that was installed from a copy of the repository (rc.11 or earlier). You do
this once. After it, you use `lares update` and `lares rollback` and never touch that copy again.
A new server needs none of this: follow [the install guide](../install.md).

Before you start:

1. **Have a fresh, proven backup.** Open the console's Backup page: it should read Protected. To
   take and check one now, as root: `systemctl start lares-backup.service`, wait for it to finish,
   then `systemctl start lares-backup-verify.service`. The switch below does not take a backup of
   its own.
2. **Know the release name.** For rc.12 it is `2026-10-21-rc.12`: the full file name, without
   `.json`, of the rc.12 file in the
   [`releases/`](https://github.com/Heiberg-Industries/lares/tree/main/releases) folder. A short
   name such as `rc.12` is refused.

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

## Security scan

Scanner: Trivy 0.75.0 (run as the `aquasec/trivy:0.75.0` container, the same version CI pins), no ignore
list, high and critical findings only, run on 2026-10-21 against the published rc.12 digests (linux/amd64)
named in `releases/2026-10-21-rc.12.json`. Six images have exactly rc.11's counts. The keeper has two
more high findings, both from one advisory published since rc.11 (below), so 30 distinct advisories in
all against rc.11's 29; none was fixed. The Debian base is still 12.15 in every image except the egress
proxy (Alpine 3.24).

| Image | Critical | High |
|---|---|---|
| console | 1 | 56 |
| keeper | 2 | 79 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 56 |
| chief-of-staff runtime | 1 | 68 |
| creative runtime | 1 | 68 |
| sync jobs | 1 | 68 |

**New since rc.11:** CVE-2026-111943 (Go standard library, `crypto/x509`: a deny-list of intermediate
certificates that are no longer trusted, for systems whose trust store is not updated). It is in the
keeper's `docker` command and its Docker Compose plugin, which come from the same pinned
`docker:29.9.0-cli` image as in rc.11; the image did not change, the advisory is new. Fixed in Go
1.26.10. Accepted for rc.12: the keeper uses both programs only to talk to the local Docker socket,
which involves no certificate checks; image downloads are done by the Docker service on the host, not by
these programs. Re-checked when Docker ships a rebuild.

Every other finding is one of those accepted for rc.10, for the reasons given in
[the rc.10 notes](rc.10-notes.md#accepted-findings), and they are accepted again for rc.12. The base
image is reviewed again before v0.1.0. Each of the seven rc.12 images was started on 2026-10-21 and
searched: no `sshd`, `systemd-homed`, `homectl` or `curl` program is present in any of them. No Node
package in any image has a high or critical finding; the only findings outside Debian's packages are
the Go advisories in the keeper's `docker` command and Docker Compose plugin.

The repository shows no open Dependabot alerts. The `sprintf-js` versions behind the moderate
advisory noted for rc.10 (GHSA-hp3w-g68c-fv3c, no patched version) are still in the lockfile, so that
note still applies.
