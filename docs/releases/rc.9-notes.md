# rc.9 release notes (draft)

rc.9 follows rc.8 (`releases/2026-10-14-rc.8.json`) and is recorded in `releases/2026-10-15-rc.9.json`. It
contains five changes, all about approvals and outside tools. There is one new database
file, `services/box/sql/003_outside_tool_seen.sql`, and one new optional setting, `LARES_CONSOLE_URL`.
The database image, the gateway and the proxy in front of the console are the same as in rc.8. The
keeper, console, sync jobs, firewall helper, egress proxy and both agent images were rebuilt from the
new source.

## What changed

- **Telegram approval cards show the outcome.** Before, tapping Approve or Cancel ran the action
  (or not) but left the card as it was, with both buttons. Now the card keeps its text, gains
  "Approved" or "Cancelled" on its own line, and loses its buttons.
- **Approval cards for private vault notes say "private note".** They used to say "Brain note".
- **The gateway is asked to cache each agent's stable prompt prefix.** Every turn re-sends the
  agent's whole persona. The model provider can bill a repeated prefix at a fraction of the normal
  price, but only up to a marked point, and the mark used to sit after the minute-by-minute clock line,
  so it never matched the previous turn. It now sits at the end of the part that stays the same for the
  whole conversation. Whether the gateway passes the mark through and reports the cache savings is
  checked by the live probe `packages/agent-kit/tests/live/gateway-prompt-cache.live.mts`, which spends
  money and is run by hand.
- **Outside tools show whether their key is present, and a locked tool can be accepted after review.** On an agent's Access tab each outside tool that needs a key now says whether its key file is
  in place (the key itself is never read). When a server changes its tool descriptions, the agent still
  locks that tool, but now keeps what the server said, and the console shows the old and new
  descriptions side by side with an "Accept new tool descriptions" button. Accepting works only for the
  exact descriptions that were shown. Before, clearing the lock meant deleting a database row by hand.
  This is the new database file.
- **A "Waiting on you" page decides any approval.** The console has a new page, `/waiting`, in the
  main menu. It lists every approval an agent is waiting on, in Telegram, Slack or web chat, and shows
  the whole text and every argument. Approve or Cancel there. Only the agent's owner sees its items.
  A Telegram card too long to read in one message now says so, links to that page and has no Approve
  button (Cancel still works). Schedule-opened conversations that ask for an approval now also appear in
  the agent's conversation list in the console.

## Upgrading from rc.8

1. Pull the rc.9 images and swap the digests in the compose file to those in
   `releases/2026-10-15-rc.9.json`, then restart the stack as for any update.
2. **Run the box database migration step**, `pnpm -C services/box migrate` (the update script already
   runs it). It applies `003_outside_tool_seen.sql`, which only adds columns and a check that are
   missing and changes no row. Running it a second time says there is nothing to apply. Until it has run,
   the Access tab says "Description checks unavailable" for outside tools. Nothing else is affected.
3. **Optional: set `LARES_CONSOLE_URL`**, the console's address (for example `https://console.example.com`),
   as a setting of the chief of staff, so that a long Telegram card can link to the Waiting on you page.
   Without it, the card says "Open the console to read the whole of it and approve it there." and the
   page still works. Add it only after the rc.9 keeper is running: the rc.8 keeper refuses a binding key
   it does not know. Then apply that agent once in the console ("apply connection changes") so the
   keeper hands the value to its container.
4. There is no new mount and no new permission. The rc.9 images need no change to the compose file beyond
   the digests.

Check: open `/waiting` in the console (it shows "nothing waiting" when no approval is open); on an agent
with an outside tool that needs a key, the Access tab says whether the key file is in place.

## Security scan

Scanner: Trivy 0.75.0 (run as the `aquasec/trivy:0.75.0` container, the same version CI pins), no ignore
list, high and critical findings only, run on 2026-10-15 against the published rc.9 digests (linux/amd64)
named in `releases/2026-10-15-rc.9.json`. The counts per image are identical to rc.8, and a package-by-package
comparison of the two scans shows the same advisories on the same packages; none is new, none is fixed.

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

| Package (images) | Findings | Upstream status | Why accepted for rc.9 |
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
untrusted format strings to them is not shown. It is accepted for rc.9 and watched for a patched release.
