# rc.13.test.4 release notes

**This is a test release, not rc.13.** It exists to test the two changes since rc.13.test.2 on a
real server, and to test `lares update` from rc.13.test.2 for the first time. It replaces
rc.13.test.3, which no server could update to (see below). Do not use it for an
installation you depend on. Its record is `releases/2026-11-03-rc.13.test.4.json`. The name
deliberately differs from the usual date, `rc.` and number, so that nobody following the install
guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `05b13fd011f1b38b51bc5e9989a6d9834d006795`. The database image, the gateway and the proxy
in front of the console are the same as in rc.12.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.13.test.2

- **An agent can save a new private note from Console chat.** In a private Console conversation the
  chief of staff was offered no way to save a note at all, so an agent whose only door is the Console
  could never write one. It now proposes one new note in the person's own private area, and every
  note needs its own approval card. Keeper writes the file only from that exact card, uses the card
  once, and refuses if a note with the same title already exists. Moving and deleting notes, and
  memory, are still not available in Console chat.
- **`lares update` and `lares rollback` work on a real server.** Before this, both refused on every
  installed server before changing anything, so no server could update to rc.13.test.3. `lares`
  passes an empty installation prefix on a real server, and the update and rollback scripts did not
  read it as the root folder. `lares update` runs the new release's own script, so a server on
  rc.13.test.2 can update straight to this release.

The database files are unchanged since rc.13.test.2.

## How it was tested

The workflow that published these images also ran the real installer on a clean CI server, as for
rc.13.test.2. On the same commit it now also covered an approved Vault note: the card answered, the
note written once to the member's private area, and the card showing the result.

**That proof has the same limits as before.** The model provider and the sign-in provider are
stand-ins, it builds its own images from the same source, and backups go to the same machine.

**Tested on a real server with rc.13.test.2** (still true of everything this release did not change):
the install guide with no changes by hand, Google sign-in and `lares owner-bootstrap`,
`lares budget setup`, creating, adopting and starting an agent, chat with a real model provider, and
an approved Track change written to the Vault.

**Not tested anywhere yet:**

- a second member and member isolation
- a real spending-limit refusal
- a real month change
- restoring onto a new server
- a power cut

## Known faults and limits

Everything listed under known faults in [the rc.13.test.2 notes](rc.13.test.2-notes.md) still
applies, apart from the missing note write. Also found while testing rc.13.test.2 on a real server:

- **Creating an agent ends on "Page not found".** The console opens the new agent's chat, which
  exists only after the agent is started. The agent itself is created correctly.
- **A stray line, "Outside connection settings (editors)", shows above the Chat heading.**
- **The email check fills the log while no mailbox is connected.** It runs every minute and logs a
  full error each time.
- **The clippings job says no Vault is set up** when the Vault areas exist.
- **After a crash, the keeper may refuse to start once.** A test that kills the keeper sometimes finds
  the old database connection still holding the spending lock, so the restarted keeper stops with
  "Financial writer lock unavailable". It starts once the database drops the old connection.
- **`lares update` cannot read the backup check on a server with no backups.** It says it could not
  read whether the backup was ever verified, and suggests the baseline database file was never
  applied, which is not the cause.

## Upgrading

`lares update --release 2026-11-03-rc.13.test.4` updates a server on rc.13.test.2. **This is the
first release to test that path.** A dry run of it on a test server on rc.13.test.2 passed; the
real update was not yet run when these notes were written. On a server with no proven backup the
update stops and asks for `--even-though-the-backup-is-unproven`. A server on rc.12 or earlier still cannot update; install fresh by
following [the install guide](../install.md).

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-03
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 32 |
| keeper | 3 | 66 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 32 |
| chief-of-staff runtime | 1 | 43 |
| creative runtime | 1 | 43 |
| sync jobs | 1 | 43 |

**No new vulnerabilities since rc.13.test.2; the findings match rc.13.test.3 exactly.** The keeper shows one more high finding because a
vulnerability already listed there is now found in one more place in the image. Every finding is
named in [the rc.13.test.2 notes](rc.13.test.2-notes.md) or an earlier release's notes, and none has
been assessed again for this test release.
