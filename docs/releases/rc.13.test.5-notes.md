# rc.13.test.5 release notes

**This is a test release, not rc.13.** It carries the fixes for what testing rc.13.test.4 on a real
server found, and it tests `lares update` from rc.13.test.4. Do not use it for an installation you
depend on. Its record is `releases/2026-11-03-rc.13.test.5.json`. The name deliberately differs from
the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `db7609c0af4e579155720f5f851ed7f888cf83c0`. The database image, the gateway and the proxy
in front of the console are the same as in rc.12.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.13.test.4

**Updating**

- `lares update` now sees a backup that `lares backups` has verified. On an installed server it no
  longer asks for `--even-though-the-backup-is-unproven` once backups work.
- On a server where backups were never set up, the update stops with "backups are not set up on this
  server yet … run sudo lares backups" instead of a shell error.
- `lares update` moves running agents onto the new release: each restarts once, at the end. An agent
  with changes waiting to be applied is left alone and named. `sudo lares agent refresh` does that
  step on its own.
- The update downloads the agents' and the keeper's helper images before it switches, so the first
  save or start afterwards no longer times out in the console.
- `lares update --release-file <path>` updates from a release file already on the server.

**Chat and approvals**

- When an action is refused while its approval card is being prepared, for example a private note
  whose title is already in use, the agent now gets the reason and says it. Before, the chat hung on
  "is running…".
- After an agent is created, its chat page says it is not started yet and shows the start command,
  instead of "Page not found". The stray "Outside connection settings (editors)" line is gone.

**Console**

- The agent edit page is laid out in two cards ("Who it is" and "What it can do") with a status card
  at the top, even field widths and one Save button that stays in view while there are unsaved
  changes. A save the keeper did not confirm in time now says so, with a real reload button, instead
  of locking the form and warning about unsaved changes.

**Keeper and jobs**

- After a crash, the keeper waits up to 5 seconds for the database to release the dead writer's lock,
  instead of refusing to settle at once.
- The keeper's log names which check holds an agent back ("is held: …").
- With no mailbox connected, email triage says so once instead of logging an error every minute.
- The clippings job says this install cannot save clippings to the Vault yet; the other clipping
  requests still work.

The database files are unchanged since rc.13.test.2.

## How it was tested

The workflow that published these images also ran the real installer on a clean CI server. On the
same commit it now also builds the software a second time and runs a real `lares update` to it after
`lares backups`, without the unproven-backup flag. It checks that the update saw the proven backup
and took its own, that the server runs the second build, that the running agent moved to it, that
`lares agent start` afterwards finds it running, and that Vault notes, spending records and sign-in
survive.

**That proof has the same limits as before.** The model provider and the sign-in provider are
stand-ins, it builds its own images from the same source, and backups go to the same machine.

**Tested on a real server with rc.13.test.4:** an update from rc.13.test.2 with data kept,
`lares backups` with a local repository, an approved Track change and an approved private note
written to the Vault, and a duplicate note refused.

**Not tested anywhere yet:**

- a second member and member isolation
- a real spending-limit refusal
- a real month change
- restoring onto a new server
- a power cut

## Known faults and limits

Everything listed under known faults in [the rc.13.test.2 notes](rc.13.test.2-notes.md) still
applies, apart from the faults fixed above. Also:

- **Scheduled jobs cannot save to the Vault on an engine-image install.** Clippings, the daily digest
  and the nightly memory job have no way to write there yet; only an approved card in a chat can.
- **"Native budget activation required" after the keeper restarts.** Seen once on a test server after
  an update; it did not happen in CI. The keeper's log will now name the check if it happens again.

## Upgrading

`lares update --release 2026-11-03-rc.13.test.5` updates a server on rc.13.test.4 or rc.13.test.2.
Because the target release's own update script runs, a server on rc.13.test.4 gets these update
fixes for this update already. A server on rc.12 or earlier still cannot update; install fresh by
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

**The findings match rc.13.test.4 exactly.** Every finding is named in
[the rc.13.test.2 notes](rc.13.test.2-notes.md) or an earlier release's notes, and none has been
assessed again for this test release.
