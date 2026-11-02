# rc.13.test.2 release notes

**This is a test release, not rc.13.** It exists to test whether a fresh install works by following
the guide, with no changes by hand. Do not use it for an installation you depend on. Its record is
`releases/2026-11-02-rc.13.test.2.json`. The name deliberately differs from the usual date, `rc.` and
number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `1680c55cd18b946652bbd6e2beec9d7cfd8a806e`. The database image, the gateway and the proxy
in front of the console are the same as in rc.12.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.13.test.1

**Installing and first use**

- The installer finishes from any folder, sets up the first organisation with the right database
  account, and can be run again after a stop.
- `sudo lares budget setup` and `sudo lares agent start <name>` replace the earlier manual steps.
- A new agent can be adopted before it has run, can be started after adoption, and gets longer to
  start the first time.
- `lares doctor` reports on migrations correctly, and backups accept the installed run folder.

**Chat and approvals**

- The gateway accepts a tool call coming back from a real provider, so a chat turn that uses a tool
  carries on.
- Approval cards other than personal mail can be answered in private chat, and an approved write to
  the Vault now completes on an installed server. Before this, the final Git step of every approved
  Vault write was refused on an installed server.
- Only the designated owner can approve a change to a company's Twenty CRM from private chat.
- An agent's question shows as text, and you answer by typing.
- Archived posts stay in private chat context.

**Spending**

- A new budget month opens by itself for accounts in use.
- The money ledger carries on past one file. Before this, spending stopped for good after about 340
  model calls.
- Overlapping model calls wait their turn instead of being refused.
- A call that never gets a final cost counts only against the month it began in.
- Spending survives a database restart, a database stall, an ordinary restart and a killed keeper.
  `lares budget recover` lifts a freeze once the records agree.

**Console and dependencies**

- Console pages follow the design system and one grid.
- `undici` is upgraded and `happy-dom` is out of the images.

## How it was tested

The workflow that published these images also ran the real installer on a clean CI server from an
ordinary folder, with real database accounts and no direct database writes. On the same commit it
covered:

- owner sign-in and `lares owner-bootstrap`
- `lares budget setup`
- creating and adopting an agent and setting a member limit, on the real console pages
- `lares agent start`
- a chat that runs a tool and carries on
- an approval card answered, the tool run, the file written to the Vault and the card showing the
  result
- every model call settled in the ledger
- `lares backups`, including a backup, a restore rehearsal and a check
- `lares doctor` reporting every migration applied

**That proof has limits.** The model provider and the sign-in provider are stand-ins. It builds its
own images from the same source and pulls them from a throwaway registry, so it does not test the
published digests, the real registry or a public certificate. Backups go to the same machine.

**Not tested anywhere yet:**

- a real server with this release
- a second member and member isolation
- a real spending-limit refusal
- a real month change
- restoring onto a new server
- a power cut
- `lares update` from this release

## Known faults and limits

- **Refusals read as outages.** The agent is told "Vault reader unavailable" for any refusal, which
  hides the real reason.
- **Some cards cannot succeed.** Track rules are checked only after the owner approves, so a card
  that can never succeed can still be approved.
- **A failed approved action shows the wrong state.** The card stays on "Waiting for the agent".
- **A message sent while the agent is answering** appears to be refused and lost. Waiting for the
  answer works.
- **`lares update` after a Vault write is untested.** Keeper's commits leave some repository files
  owned by root, and the installer's Vault checks run as the runtime user.
- **A backup older than the latest spending** leaves spending off for good after it is restored.
- **A key action interrupted just after its money step** needs checking by hand.
- **Unfinished calls within a month.** They still hold their amount until the month ends, so a
  provider outage can block someone until then.
- **A final cost above the reservation** freezes the installation.
- **Calls still running at midnight** belong to the old month while the new month has its whole
  limit, so a provider's calendar-month invoice can exceed the limit by what those calls cost.
- **Ledger growth.** The ledger's books take about 24.5 KB per call on disk and are never removed.
  Nothing has been measured past 1,500 calls.

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

A fresh install applies the database files up to `034_private_metadata_devices.sql` in
`services/box/sql/`. There is no file numbered `010`.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-02
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 32 |
| keeper | 3 | 65 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 32 |
| chief-of-staff runtime | 1 | 43 |
| creative runtime | 1 | 43 |
| sync jobs | 1 | 43 |

**Gone since rc.13.test.1:** `undici` and `happy-dom` no longer appear.

**New since rc.13.test.1, and not accepted for a finished release:** `libexpat1` (CVE-2026-117610,
CVE-2026-118370), a Debian package in the keeper, both agent images and sync jobs, with no fix
available. Unresolved here: not assessed.

**Still unresolved from rc.13.test.1:** SQLite (CVE-2025-7458 critical; CVE-2026-11822, CVE-2026-11824,
CVE-2026-119373) and Python 3.11 (CVE-2026-7210, CVE-2026-11940), Debian packages in the keeper image
with no fix available. Not assessed.

Every other finding is named in an earlier release's notes, and those reasons have not been reviewed
again for this test release.
