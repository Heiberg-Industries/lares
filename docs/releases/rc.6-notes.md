# rc.6 release notes (draft)

## Upgrading: adopt the migration baseline

The numbered history of the box database (`services/box/sql`) is replaced by one file,
`001_baseline.sql`, which creates the whole schema in one step. A new install applies it. An
existing database is refused with one message until it adopts the baseline:

1. Bring the database to the last pre-release file, `094_outside_tool_pins.sql`.
2. Apply the renames the baseline expects, in one transaction:
   - `telegram_session_rotation.oslo_day` becomes `local_day`;
   - `voice_profile.english` becomes `notes_en` and `voice_profile.norsk` becomes `notes_no`
     (pending voice proposals that still use the old key names need the same rename);
   - the default of `voice_profile.learn_key` becomes `'chief-of-staff'`.
   The market tables are gone from the baseline; dropping them is optional.
3. Mark the baseline as applied without running it:
   `pnpm -C services/box migrate --adopt-through 001_baseline.sql --dry-run`, then the same
   command without `--dry-run`. The adoption accepts a ledger that records the whole pre-release
   history (it is replaced by the baseline's one row) or an empty ledger on a database that was
   migrated by hand; it refuses a partial history. Every later change is a new file numbered
   above 001.

## Upgrading: the console needs a session secret file

The console refuses to start without `CONSOLE_SESSION_SECRET_FILE`: the path of a file that holds
the secret used to sign console sessions. Passing the secret itself as a setting
(`CONSOLE_SESSION_SECRET`) is not enough and leaves the console restarting in a loop.

- A new install creates the file for you (`console-session-secret` in the secrets folder) and the
  generated compose file points the console at it.
- An existing installation that wrote its own compose file must add the variable and mount the
  file into the console container before updating, then keep the secret's value unchanged so
  signed-in owners stay signed in.
- If the compose file reads values with `${...}` interpolation, start it with `--env-file`
  pointing at the file that holds them; without it the values come through empty.

## Upgrading: the console needs the deadline calendar file mounted

Setting `DEADLINE_CALENDAR_FILE` is not enough for the console: the file itself must also be
mounted into the console container, read-only, at the same path, or the Deadlines page fails with
a "file not found" error. In the console's compose service, next to its other volumes:

```yaml
    volumes:
      - /srv/lares/installation/deadline-calendar.json:/srv/lares/installation/deadline-calendar.json:ro
```

The installation folder `/srv/lares/installation` is part of what the backup, the export and the
restore drill cover when it exists.

## Old capabilities in saved agent definitions

rc.6 removes several capabilities (network, the company-registry lookup, markets and the travel-only ones). A saved
agent that still holds one of them is shown in the console's definition form, under Access and
skills, as "no longer available in this version" with a Remove button. The save is refused until
the grant is removed; nothing is dropped without the owner pressing the button.

## Company data is now an outside tool

The built-in company-registry lookup and its tools are gone from the engine. The commercial
skill and the sales-outreach skill work without it: they read the CRM, the mail and the web, and
use an outside tool for company data if the owner has connected one. A keeper config file that
still lists an endpoint the engine no longer supports under the egress endpoints loads
anyway: the keeper logs one line per ignored key and drops it. No edit is required.

## Wording

The approval card for a note in the shared vault area now reads "Write note to Shared notes",
not "Atlas note".

## The travel role is gone

The engine now ships two roles, the chief of staff and the creative role. The travel role, its
container image and its CI build are removed, and so are the chief of staff's trip reader (the
`travel` capability with its `travel_read` and `travel_current` tools) and every setting only the
travel role read. The morning and evening briefs no longer read a trip store; their "Travel
context" block comes from the calendar alone, and a day with a trip but nothing else on it no
longer earns a brief by itself.

- A saved chief-of-staff definition that still holds the `travel` capability is shown as "no longer
  available in this version" and must have it removed before the next save (see the section above).
- An existing keeper config file loads unchanged. A `travel` entry under the image list, the role
  defaults or a named binding is ignored with one log line each, and so are the retired environment
  settings the travel role used. A stored travel agent definition is skipped, with a log line, when
  the keeper builds the compose file, the egress rules and the credential inventory, so it cannot
  break the other agents. The keeper no longer starts, stops or updates it. A travel agent that
  keeps running outside the keeper stays reachable through its entry under the egress legacy
  consumers.
- The `/srv/taste` store and the console's taste pages stay; they are not part of the travel role's
  code.

## Settings with an agent or organisation in their name were renamed

Several settings carried an agent's name or an organisation's name in the variable. They are now
neutral, so an installation updates its own settings once, before the update:

- The chief of staff's route-password variable is `EVE_ROUTE_PASSWORD_FILE`, the same one the
  creative role already used. The keeper's default bindings and the installer write it that way.
  A keeper config file that still binds the old name is refused until the binding is renamed.
- The per-role model override is `AGENT_MODEL` for both the chief of staff and the creative
  role. When it is unset, the agent's own definition model is used, as before.
- The optional Strava client file variables are `STRAVA_CLIENT_ID_FILE` and
  `STRAVA_CLIENT_SECRET_FILE`.
- Google organisations are no longer listed in the engine. A mailbox's organisation id picks the
  client pair by name: `GOOGLE_CLIENT_ID_<ORG>_FILE` and `GOOGLE_CLIENT_SECRET_<ORG>_FILE`, or
  the default files `google-client-id-<org>` and `google-client-secret-<org>` in the secrets
  folder. The console and the Notion sync discover organisations from the same
  `GOOGLE_CLIENT_ID_<ORG>` names. An installation that already used this spelling needs no change.
- The creative role's Slack door defaults to the same file names as the chief of staff's
  (`eve-slack-bot-token`, `eve-slack-signing-secret`) when the keeper does not set the paths.
- The keeper no longer ignores the retired agent-named environment settings of the removed
  travel role in a runtime binding; a binding that still carries one must drop it.
- The connection catalogue (`integrations/installation.json`) ships with one neutral instance
  per connection and names no organisation or agent.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run on 2026-10-14 against
the published rc.6 digests (linux/amd64) named in `releases/2026-10-14-rc.6.json`. The same 28
advisories appear as in the build-only scan before publishing; none is new.

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
or upstream.

### Accepted findings

These are accepted for this release candidate. The base image is reviewed again before v0.1.0.
"Accepted" is a release decision, not proof that a finding cannot be reached. "All Debian images"
means every image above except the egress proxy.

| Package (images) | Findings | Upstream status | Why accepted for rc.6 |
|---|---|---|---|
| zlib1g (all Debian images) | CVE-2023-45853 (critical) | Debian: will not fix | The flaw is in the zip-writing helper (minizip), which Debian does not ship in zlib1g. |
| openssh-client (keeper) | CVE-2026-60002 (critical), CVE-2026-59999, CVE-2026-60000, CVE-2026-106553, CVE-2026-106555, CVE-2026-106583 | Debian: fix deferred | The client is used only by the optional Git backup of agent definitions, and only to reach the repository the owner configured. No ssh server ships (checked in the scan). Several of these describe the server, not the client. |
| Docker Compose plugin (keeper) | CVE-2026-78667, CVE-2026-78669, CVE-2026-97031 (Go standard library and x/net) | Fixed in Go 1.26.9; Compose 5.6.0, the newest release, is still built with 1.26.8 | The keeper runs Compose only against compose files it writes itself, on the local Docker socket. The `docker` CLI binary next to it is on 29.9.0 and clear of these. Re-checked when Compose ships a rebuild. |
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
