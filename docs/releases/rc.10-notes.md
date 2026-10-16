# rc.10 release notes (draft)

rc.10 follows rc.9 (`releases/2026-10-15-rc.9.json`) and is recorded in `releases/2026-10-16-rc.10.json`. It
contains nine changes, almost all from a stranger's first install of the tested path on a
fresh server: the installer, backups and restore, and what a fresh installation with only web chat and
Telegram does. There is no new database file and no new setting. The database image, the gateway and the
proxy in front of the console are the same as in rc.9. The keeper, console, sync jobs, firewall helper,
egress proxy and both agent images were rebuilt from the new source. The keeper's own code is unchanged;
it picks up the approval change below through a shared package.

## What changed

### Installing, backing up and restoring

- **An installer re-run keeps the Google connection and restarts the keeper only on change.**
  Before, re-running the installer wiped the Google mail and calendar settings from the keeper's settings
  file. Now they are carried over, and if that file cannot be read the installer stops and leaves it
  untouched. The keeper restarts only when its settings actually changed. When
  `/srv/lares/installation/deadline-calendar.json` is a plain file, the chief of staff gets it read-only
  (the creative agent never does).
- **One command switches backups on and proves them once.** `./services/box/ops/install.sh
  --backups` asks where backups go, refuses unsafe answers before writing anything, sets up the
  repository and the three timers, then runs one backup, one restore rehearsal and one check. It prints
  "Protected" only when all three pass. It replaces the ten hand steps in the guide's backup section.
- **Restore onto a new server is one guided command.** `./services/box/ops/restore.sh --snapshot
  latest` restores the databases and the installation's folders from a nightly snapshot onto a freshly
  installed server, refusing anything that is not fresh, and then prints the manual steps that remain.
  The nightly backup now also encrypts the agents' token folder (`/srv/lares/secrets`), so a restore no
  longer means reconnecting every chat door and outside tool by hand.
- **Install guide and installer output.** The guide now says the server needs Node.js and pnpm,
  lists the Telegram and Slack steps as the console shows them, puts DNS first on a restore and explains
  the backup repository settings. A dry run no longer shows the start-fresh or restore menu, the default
  path no longer reads `//srv/lares`, internal labels and orphan warnings are gone from the output.

### A fresh installation that works without hand fixes

- **Web chat can approve when no chat door is connected.** Before, an approval needed a connected
  Telegram, Slack or email door; with only web chat, every approval failed. Now a session opened from the
  console's signed-in web chat may approve when no door is claimed. A claimed door keeps the strict rules.
- **The installer writes the public door address.** Without it, Telegram webhook registration and
  Slack app creation were refused.
- **Schedules are on by default.** The create-agent review page already lists the schedules an
  agent will run; the master switch no longer silently holds them back. An installer re-run keeps whatever
  the settings file already says.
- **Agents run on the owner's clock.** The installer hands the owner's time zone to both roles, so
  briefs and quiet hours follow it instead of UTC.
- **A brief arrives without Google.** An unreadable calendar or mailbox no longer stops the morning
  brief: it goes out with what could be read and a "Sources not available" block. The evening pass still
  stays silent when a gap is its only news.
- **Chief of staff rough edges.** Long replies are no longer cut off at 4,096 tokens (every model
  call now gets 16,384 unless it sets its own). Without a vault, the clipping schedule logs one line
  instead of failing every minute; Slack-only schedules log one "Slack is not connected" line. After a
  claim on Telegram or Slack the agent confirms it; any message it cannot use yet gets one fixed line. The
  agent describes only what is really connected. Approval cards use plain field names.

### Console

- **Sign out.** A Sign out button at the bottom of the sidebar clears the session. Signed-in pages
  are no longer cached, so the back button does not show console data afterwards.
- **Web chat shows formatting.** Agent replies show bold, lists, headings, code and links instead of
  literal marks. Model output is still untrusted: the renderer builds only allowed elements, raw HTML shows
  as text, and only `http`, `https` and `mailto` links become links.
- **The Waiting on you page says why an agent could not be read.** It groups agents by reason ("did
  not answer in time", "refused the console's request", "could not be reached", "returned an error"), and
  the console logs one line per agent with the kind and status only. Retired agents are never asked.

## Upgrading from rc.9

1. Pull the rc.10 images and swap the digests in the compose file to those in
   `releases/2026-10-16-rc.10.json`, then restart the stack as for any update. There is no new database
   file; the migration step says there is nothing to apply.
2. **Turn schedules on once by hand.** A keeper settings file written by the rc.9 installer says
   `"schedulesLive": false`, and a re-run keeps that value because it cannot tell it from an owner's choice.
   Set it to `true` in `/etc/lares/keeper.json` before the next step.
3. **Re-run the installer once** (`./services/box/ops/install.sh --release
   releases/2026-10-16-rc.10.json`), so the keeper's settings gain the public door address and the owner's
   time zone in each role's default binding. It restarts the keeper because its settings changed. Then
   apply each agent once in the console so its container gets `OWNER_HOME_TZ` (and the deadline calendar,
   when that file exists). An agent with its own binding does not get the time zone from the installer;
   add it to that binding.
4. **Backups:** nothing to change. The first nightly backup after updating adds the token folder to the
   encrypted bundle; older snapshots do not have it. A server whose backups were set up by hand keeps its
   `/etc/agent-box/backup.env`.
5. There is no new mount and no new permission beyond the optional deadline calendar.

Check: the console sidebar has Sign out; `docker inspect` of an agent shows `OWNER_HOME_TZ`; the
Proactivity page shows schedules running.

## Security scan

Scanner: Trivy 0.75.0 (run as the `aquasec/trivy:0.75.0` container, the same version CI pins), no ignore
list, high and critical findings only, run on 2026-10-16 against the published rc.10 digests (linux/amd64)
named in `releases/2026-10-16-rc.10.json`. A package-by-package comparison with the rc.9 scan shows one new
advisory and none fixed: CVE-2026-53615 (high) on the eight util-linux packages, published since rc.9.
The package versions are the same as in rc.9 (util-linux 2.38.1-5+deb12u3); Debian lists it as affected
with no fix. It adds eight findings to every Debian image; nothing else changed.

| Image | Critical | High |
|---|---|---|
| console | 1 | 56 |
| keeper | 2 | 77 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 56 |
| chief-of-staff runtime | 1 | 68 |
| creative runtime | 1 | 68 |
| sync jobs | 1 | 68 |

The counts are findings per package, so one advisory in seven util-linux packages counts seven
times. Every finding except the four on the keeper's Docker Compose plugin has no fix in Debian 12
or upstream. The Debian base is 12.15 in every image except the egress proxy.

### Accepted findings

These are accepted for this release candidate. The base image is reviewed again before v0.1.0.
"Accepted" is a release decision, not proof that a finding cannot be reached. "All Debian images"
means every image above except the egress proxy.

| Package (images) | Findings | Upstream status | Why accepted for rc.10 |
|---|---|---|---|
| zlib1g (all Debian images) | CVE-2023-45853 (critical) | Debian: will not fix | The flaw is in the zip-writing helper (minizip), which Debian does not ship in zlib1g. |
| openssh-client (keeper) | CVE-2026-60002 (critical), CVE-2026-59999, CVE-2026-60000, CVE-2026-106553, CVE-2026-106555, CVE-2026-106583 | Debian: fix deferred | The client is used only by the optional Git backup of agent definitions, and only to reach the repository the owner configured. No ssh server ships (checked in the scan). Several of these describe the server, not the client. |
| Docker Compose plugin (keeper) | CVE-2026-78667, CVE-2026-78669, CVE-2026-97031 (Go standard library and x/net) | Fixed in Go 1.26.9; the Compose build in the image is still on an older Go | The keeper runs Compose only against compose files it writes itself, on the local Docker socket. The `docker` CLI binary next to it is clear of these. Re-checked when Compose ships a rebuild. |
| util-linux family: bsdutils, libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra (all Debian images) | CVE-2026-53613, CVE-2026-53615, CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | Debian: affected, no fix | Mount and namespace tools. Agent containers run as an unprivileged user with every capability dropped, read-only and with no-new-privileges; the console and sync jobs run as an unprivileged user. The keeper and firewall helper run as root, and no engine code calls mount, nsenter or unshare. |
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
critical finding. "Checked in the scan" means each of the seven rc.10 images was started on 2026-10-16 and
searched: no `sshd`, `systemd-homed`, `homectl` or `curl` program is present in any of them.

### Dependabot alert (not a Trivy finding)

GitHub reports one open Dependabot alert on the repository: `sprintf-js`, moderate severity, denial of
service through unbounded precision specifiers (GHSA-hp3w-g68c-fv3c), with no patched version. It is
below the scan's severity floor. Both locked versions (1.0.3 and 1.1.3) are present in the keeper, the
chief-of-staff runtime and the creative runtime, pulled in by the agent framework's shell helper and by
a document converter; they are not in the console or sync-jobs images. Whether any engine path passes
untrusted format strings to them is not shown. It is accepted for rc.10 and watched for a patched release.
