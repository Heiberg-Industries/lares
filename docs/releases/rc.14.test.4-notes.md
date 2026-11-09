# rc.14.test.4 release notes

**This is a test release, not rc.14.** It is rc.14.test.3 plus the chief of staff working on its
owner's own Google mailbox, the first part of the new Connections pages, an agent's own model key in
the console, and `lares vault import`. Do not use it for an installation you depend on. Its record
is `releases/2026-11-09-rc.14.test.4.json`. The name deliberately differs from the usual date, `rc.`
and number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `58df70e3c93115f1f5f5eea8959b82e6028d53f8`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.test.3.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

Two changes merged after that commit are **not** in this release: the one-command Google live check
with the install guide's "switch on the Google APIs" step, and the per-service Integrations pages.

## What changed since rc.14.test.3

- **The chief of staff works on a mailbox you choose.** You connect your own Google account on the
  new **Your accounts** page with the permission "Read mailbox, calendar and Drive files, write
  drafts, and add or change calendar events (each one approved by you)". On the agent's Access
  tab, under Mailbox, you choose that account. Only the agent's owner can choose, and only one of
  their own accounts. If you disconnect or reconnect the account, or the agent changes owner, the
  agent stops using it and the tab says why; after a reconnect, "Confirm" lets it carry on.
- **With that mailbox the agent:**
  - sorts new mail and writes reply drafts in Gmail. It never sends: sending is refused in Lares,
    even though Google's draft permission could send.
  - reads a Google Docs, Sheets or Slides link you send it, read only.
  - adds, changes and deletes calendar events, each one only after you tap Approve.

  Briefs, triage, voice learning, outreach replies and the other mail readers all use the chosen
  mailbox and nothing else.
- **The e-mail door is removed.** Agents no longer get a mailbox from the server's settings. An
  agent definition that still has an `email` door is refused with a plain finding, and the agent
  keeps its last valid definition. The settings that only the door read are gone.
- **Your accounts and an Integrations grid.** "Connections" in the menu is now two pages:
  - **Your accounts** (every member): their own Google and Microsoft accounts;
  - **Integrations** (owner only): a searchable grid of the shared services. In this release
    each card still opens the old details page.
- **An agent's own model key from the console.** The designated owner can set or remove it on the
  agent's Access tab. The key is never shown again and is not tested.
- **`lares vault import <folder>`** brings an existing folder of notes into the Vault: preview
  first, then apply exactly the confirmed plan; safe to run again.

The database gains one file, `036_agent_account_bindings.sql`: which of its owner's accounts each
agent works on. It holds no credential.

## Before you update or install

- **Google Cloud project:** switch on the **Gmail API**, the **Google Calendar API** and the
  **Google Drive API**. The client's consent screen must list `gmail.readonly`, `gmail.compose`,
  `calendar.readonly`, `calendar.events` and `drive.readonly`.
- **An existing agent with an e-mail door:** delete the door from its `agent.json` first.
- **After the update:** reconnect Google on Your accounts with the permission above, then choose
  the mailbox on the chief of staff's Access tab. An account connected earlier with "read" only
  cannot be chosen; one connected with drafts but before Drive and calendar events were added keeps
  working for mail and drafts, and asks you to reconnect when it needs the rest.

## How it was tested

The workflow that published these images ran the real-install proof on the same commit, including a
chat after `lares update`. Its limits are unchanged: stand-in model and sign-in providers, its own
images built from the same source, backups on the same machine, one person.

The Google side was checked live by hand on 9 November, on this commit, with one "read + drafts"
sign-in:
- a draft to self was created, read back and deleted, and nothing was sent;
- a Doc's details and text were read;
- a private calendar event with no guests was added, read back, changed and deleted.

All checks passed.

**Not tested anywhere yet:**
- the agent mailbox on a real install: that is the test this release is for;
- the same list as in [the rc.14.test.1 notes](rc.14.test.1-notes.md): a power cut, a second
  member, a real spending-limit refusal, a real month change, an agent's own provider key against
  a real provider, restoring onto a new server;
- `lares vault import` on a real install.

## Known faults and limits

- The Integrations cards open one shared details page. The per-service pages come in the next test
  release.
- Disconnecting an account in Lares does not withdraw its permission at Google; do that in your
  Google account's third-party access settings.
- Everything listed in [the rc.14.test.3 notes](rc.14.test.3-notes.md) still applies.

## Upgrading

`lares update --release 2026-11-09-rc.14.test.4` updates a server on rc.14.test.3, rc.14.test.2,
rc.14.test.1 or rc.13.test.5. A server on rc.12 or earlier still cannot update; install fresh by
following [the install guide](../install.md).

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-09
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 34 |
| keeper | 3 | 73 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 34 |
| chief-of-staff runtime | 1 | 47 |
| creative runtime | 1 | 47 |
| sync jobs | 1 | 47 |

The counts are the same as for rc.14.test.3, image by image. Only the totals were compared, not
each finding. The findings were named in [the rc.14.test.2 notes](rc.14.test.2-notes.md) and earlier
releases' notes.

## How it was published

One manual run of each of the three image workflows on the same commit, all of which passed the
first time:
- keeper and agents: run 42693491727, including the real-install proof;
- console: run 42693857031;
- sync jobs: run 42693894776.
