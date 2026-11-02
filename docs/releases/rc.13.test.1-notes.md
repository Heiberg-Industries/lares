# rc.13.test.1 release notes

**This is a test release, not rc.13.** It exists so the work merged since rc.12 can be tested on a
freshly installed server. Do not use it for an installation you depend on. Its record is
`releases/2026-11-02-rc.13.test.1.json`. The name deliberately differs from the usual date, `rc.`
and number, so that nobody following the install guide picks it by accident.

## What it is built from

The keeper, egress proxy, firewall helper, both agent images and sync jobs were built from commit
`18e553c9615192abb06281c92781f3f39c8b1767`. The console was built from
`cd92be57f4357596b4e946762120f4587e729944`, which differs only by one file: a corrected check in
`services/console/tests/start-admission-image.probe.py`, which is not part of the image. The database
image, the gateway and the proxy in front of the console are the same as in rc.12.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What is new since rc.12

- Members with their own sign-in, sessions, invitations and permissions on shared agents.
- Personal connected accounts for Google and Microsoft mail and calendar.
- Member budgets, enforced through the included gateway. There is no installer choice for an
  external gateway.
- Separate database accounts, with the administrator password kept away from running services, and a
  maintenance check that services must pass to start.
- Vault areas with access checks, and erasure of a person's data.
- Outside tools with held credentials and an approval for each exact action.
- Tracks, which replace the fixed CRM with work you define.
- A read-only preview of an export for later selective import.

A fresh install applies the database files up to `034_private_metadata_devices.sql` in
`services/box/sql/`. There is no file numbered `010`.

## What is not finished

- Selective import can preview but cannot write anything.
- Member-owned scheduled jobs.
- Mailbox signatures and attribution.
- Help and website content matched to this release.
- Live checks with real Microsoft accounts have not been run.

## Upgrading

**A server on rc.12 or earlier cannot update to this release.** `lares update` refuses it before
changing anything, because such a server has none of the separate database accounts or the
maintenance state this release requires, and this release deliberately does not take over a database
it did not set up. Install it on a fresh server by following [the install guide](../install.md).

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-02
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 32 |
| keeper | 3 | 78 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 32 |
| chief-of-staff runtime | 1 | 55 |
| creative runtime | 1 | 55 |
| sync jobs | 1 | 47 |

**New since the rc.12 notes, and not accepted for a finished release:**

- **`undici`, a web request library** (CVE-2026-87018, CVE-2026-109383, CVE-2026-109829,
  CVE-2026-109869; in the keeper, both agent images and sync jobs). Lares uses this library for outside
  connections, and fixed versions exist. Unresolved here: its exposure has not been assessed, and it
  should be upgraded before rc.13.
- **`happy-dom`** (CVE-2026-115895, CVE-2026-118660; same images). It is present only as an optional
  dependency of the test tool, and no Lares code imports it. It should be removed from the images.
- **SQLite** (CVE-2025-7458 critical; CVE-2026-11822, CVE-2026-11824, CVE-2026-119373) and **Python
  3.11** (CVE-2026-7210, CVE-2026-11940), Debian packages in the keeper image with no fix available.
  Unresolved here: not assessed.

Every other finding is named in an earlier release's notes, and those reasons have not been reviewed
again for this test release.
