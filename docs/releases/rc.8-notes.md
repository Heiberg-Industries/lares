# rc.8 release notes (draft)

rc.8 follows rc.7 (`releases/2026-10-14-rc.7.json`) and is recorded in `releases/2026-10-14-rc.8.json`. It
contains one change: the keeper re-applies the outbound firewall by itself at startup. The database
files, the settings and the agent images' behaviour are as in rc.7. The keeper image changed, and so did
the other images, which were rebuilt from the same source.

## What changed

- **The keeper re-applies the last installed outbound firewall when it starts.** In rc.7 a reboot left
  agents without the firewall until the next agent change. Now a keeper restart or a host reboot
  restores the rules without any action.

## Upgrading from rc.7

1. Pull the rc.8 images and swap the digests in the compose file to those in
   `releases/2026-10-14-rc.8.json`, then restart the stack as for any update. There is no new database
   file and no new setting.
2. **Apply one agent once.** After the upgrade the keeper has no record of an installed firewall until
   the first agent change. In the console, use the keeper's "apply connection changes" on any agent. From
   then on, a restart or reboot re-applies the firewall by itself.
3. Check: `nft list tables` shows `lares_egress`, and `nft list table inet lares_egress` shows the rules,
   including an `ip saddr != { ... } accept` line. If you have not yet removed the older table left by
   the rc.6 to rc.7 rename, the rc.7 notes describe how.

### Known issue from rc.7: fixed

rc.7 did not re-apply the outbound firewall after a reboot until the next agent change. Fixed in rc.8.
The workaround of applying an agent after each reboot is no longer needed once the one-time
apply in step 2 is done.

## Security scan

Scanner: Trivy 0.75.0 (run as the `aquasec/trivy:0.75.0` container, the same version CI pins), no ignore
list, high and critical findings only, run on 2026-10-15 against the published rc.8 digests (linux/amd64)
named in `releases/2026-10-14-rc.8.json`. The counts per image are identical to rc.7, and a package-by-package
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

| Package (images) | Findings | Upstream status | Why accepted for rc.8 |
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
untrusted format strings to them is not shown. It is accepted for rc.8 and watched for a patched release.
