# rc.7 release notes (draft)

rc.7 follows rc.6 (`releases/2026-10-14-rc.6.json`) and is recorded in `releases/2026-10-14-rc.7.json`. It
changes standing facts, the outbound firewall's table name, backups and the CRM organisation-number
field, and removes names that identified one installation. Nothing in it is mandatory before the
keeper starts: the rc.7 keeper accepts everything the rc.6 keeper accepted.

## What changed

- **Standing facts live on one schema path.** The `standing_facts` table is now created by
  `services/box/sql/002_standing_facts.sql` (new on a fresh install, and applied by `pnpm -C services/box migrate`
  on update). The four hand-applied chief-of-staff files that used to add its columns are removed, and so
  are the fallbacks that tolerated a table without them.
- **Backups include the installation folder.** `/srv/lares/installation` (the deadline calendar and the
  installation's other own data) is part of the backup, the verify job, the restore drill and the export
  when the folder exists.
- **The console's calendar mount is rendered by the installer.** The generated compose file mounts
  `deadline-calendar.json` read-only into the console when it exists in the installation folder. A
  hand-written compose file is not touched; it still needs the mount described in the rc.6 notes.
- **The CRM organisation number can come from a field the installation names.** The new optional setting
  `TWENTY_ORG_NUMBER_FIELD` names the company field that holds it. Unset or blank keeps `orgNumber`, so
  behaviour is the same as rc.6.
- **Install guide.** `docs/install.md` walks through a fresh server.
- **Scrub.** Names that identified one installation or agent are removed from comments, fixtures and
  placeholders. The one visible effect: the Telegram placeholder bot username used when
  `TELEGRAM_BOT_USERNAME` is unset reads `lares_example_bot_UNSET`. No setting, container, database or
  file name changed except the firewall table below.

## Upgrading from rc.6

### Before updating

1. **Check the standing-facts table.** The old tolerance for a half-updated table is gone: with a column
   missing, every read and write of facts fails and the agent loses its standing facts without a
   visible error. On the live database, read-only:

   ```sql
   SELECT column_name FROM information_schema.columns WHERE table_name = 'standing_facts' ORDER BY 1;
   ```

   It must list: category, fact, id, origin, recorded_at, retired_at, source, source_turn, stated_at,
   superseded_by, user_id. The new migration creates the table when it is missing but never repairs a
   table in an older shape. A table with columns missing must be brought up to date before updating.
2. **Copy the new host scripts** `backup.sh`, `backup-verify.sh`, `restore-drill.sh` and `export.sh`
   (from `services/box/ops`) to the host before the first backup run, when `/srv/lares/installation`
   exists. The rc.6 backup script ends with an "unclassified Lares store" error on that folder, so the
   nightly backup would fail closed.
3. Keep `TWENTY_ORG_NUMBER_FIELD` out of keeper bindings until the rc.7 keeper is running; an older keeper
   refuses a binding key it does not know.

### After the new images are up

1. **The migration.** `pnpm -C services/box migrate` (the update script already runs it) applies
   `002_standing_facts.sql`: create-if-missing for the table and its two indexes. On a database that
   already has `standing_facts` it changes nothing and touches no row.
2. **The firewall table was renamed to `lares_egress`.** The rc.7 keeper writes the new table when it next
   applies the firewall (on any agent register, start, update or egress change, not at keeper start). It
   does not remove the old one, so both rule sets stay active, and the old one keeps filtering on rules
   that no longer change. Once, after that first apply has succeeded:
   - `nft list tables` shows `lares_egress` and the older table of the same kind;
   - `nft list table inet lares_egress` shows the rules, including an `ip saddr != { ... } accept` line;
   - then `nft delete table inet <the older table's name>`.

   Delete only after the new table is there, so there is no window without a firewall. If the host
   loads a saved nft file at boot that defines the old table, edit that file too.
3. **Backup after upgrading.** Run one backup, then the verify job. A snapshot made before the rc.7
   backup script lacks the installation folder, and the first verify reports it as missing paths.
   `backup.env.example` now sets `LARES_CURRENT_LAYOUT=1` and uses `/etc/lares/` paths; an existing
   `backup.env` is not rewritten.

### Known issue

The keeper does not re-apply the outbound firewall after a reboot until the next agent change.
A fix is planned for the next release. Workaround: after a reboot, apply any agent once through the
keeper.

## Security scan

Scanner: Trivy 0.75.0 (run as the `aquasec/trivy:0.75.0` container, the same version CI pins), no ignore
list, high and critical findings only, run on 2026-10-14 against the published rc.7 digests (linux/amd64)
named in `releases/2026-10-14-rc.7.json`. The counts per image are identical to rc.6 and the advisories
are the same ones as in the rc.6 notes; none is new, none is fixed.

| Image | Critical | High |
|---|---|---|
| console | 1 | 48 |
| keeper | 2 | 69 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 48 |
| chief-of-staff runtime | 1 | 60 |
| creative runtime | 1 | 60 |
| sync jobs | 1 | 60 |

The counts are findings per package, so one advisory in seven util-linux packages counts seven
times. Every finding except the four on the keeper's Docker Compose plugin has no fix in Debian 12
or upstream. The Debian base is 12.15 in every image except the egress proxy.

### Accepted findings

These are accepted for this release candidate. The base image is reviewed again before v0.1.0.
"Accepted" is a release decision, not proof that a finding cannot be reached. "All Debian images"
means every image above except the egress proxy.

| Package (images) | Findings | Upstream status | Why accepted for rc.7 |
|---|---|---|---|
| zlib1g (all Debian images) | CVE-2023-45853 (critical) | Debian: will not fix | The flaw is in the zip-writing helper (minizip), which Debian does not ship in zlib1g. |
| openssh-client (keeper) | CVE-2026-60002 (critical), CVE-2026-59999, CVE-2026-60000, CVE-2026-106553, CVE-2026-106555, CVE-2026-106583 | Debian: fix deferred | The client is used only by the optional Git backup of agent definitions, and only to reach the repository the owner configured. No ssh server ships (checked in the scan). Several of these describe the server, not the client. |
| Docker Compose plugin (keeper) | CVE-2026-78667, CVE-2026-78669, CVE-2026-97031 (Go standard library and x/net) | Fixed in Go 1.26.9; the Compose build in the image is still on an older Go | The keeper runs Compose only against compose files it writes itself, on the local Docker socket. The `docker` CLI binary next to it is clear of these. Re-checked when Compose ships a rebuild. |
| util-linux family: bsdutils, libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra (all Debian images) | CVE-2026-53613, CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | Debian: affected, no fix | Mount and namespace tools. Agent containers run as an unprivileged user with every capability dropped, read-only and with no-new-privileges; the console and sync jobs run as an unprivileged user. The keeper and firewall helper run as root, and no engine code calls mount, nsenter or unshare. |
| libcurl3-gnutls (keeper, both role runtimes, sync jobs) | CVE-2026-6276, CVE-2026-8286, CVE-2026-8458, CVE-2026-8927, CVE-2026-12064 | Debian: affected or fix deferred | No `curl` program ships (checked in the scan); the library is present as a dependency of git, which reaches only remotes the installation configures. Reachability through git is not shown. |
| libssl3, openssl (keeper, both role runtimes, sync jobs) | CVE-2026-84782 | Debian: affected | DTLS (TLS over UDP); the engine does not use DTLS. |
| libexpat1 (keeper, both role runtimes, sync jobs) | CVE-2026-77214 | Debian: affected | XML parser pulled in by git; the engine's own code does not use it. Reachability through git is not shown. |
| libldap-2.5-0 (keeper, both role runtimes, sync jobs) | CVE-2023-2953 | Debian: affected | Pulled in by libcurl; the engine makes no LDAP connections. |
| libsystemd0, libudev1 (all Debian images) | CVE-2026-16742 | Debian: fix deferred | Located in systemd-homed, which does not ship (checked in the scan). |
| gzip (all Debian images) | CVE-2026-41992 | Debian: fix deferred | LZH decompression; the engine does not decompress untrusted archives with gzip. |
| libacl1 (all Debian images) | CVE-2026-54369 | Debian: fix deferred | Needs a privileged process that sets ACLs through attacker-placed symlinks; no engine code sets ACLs. |
| perl-base (all Debian images); perl, libperl5.36, perl-modules-5.36 (keeper, both role runtimes, sync jobs) | CVE-2026-9538 | Debian: fix deferred | Archive::Tar on crafted tar files; the engine runs no Perl. |
| ncurses-base, ncurses-bin, libtinfo6 (all Debian images) | CVE-2025-69720 | Debian: affected | Terminal handling; `infocmp` is present, but nothing runs on a terminal fed by untrusted input. |

The egress proxy has no findings at any severity. No Node package in any image has a high or
critical finding. "Checked in the scan" refers to the publish runs' image evidence, which records
that no `sshd`, `systemd-homed`, `homectl` or `curl` program is present in any of the seven images.

### Dependabot alert (not a Trivy finding)

GitHub reports one open Dependabot alert on the repository: `sprintf-js`, moderate severity, denial of
service through unbounded precision specifiers (GHSA-hp3w-g68c-fv3c), with no patched version. It is
below the scan's severity floor. Both locked versions (1.0.3 and 1.1.3) are present in the keeper, the
chief-of-staff runtime and the creative runtime, pulled in by the agent framework's shell helper and by
a document converter; they are not in the console or sync-jobs images. Whether any engine path passes
untrusted format strings to them is not shown. It is accepted for rc.7 and watched for a patched release.
