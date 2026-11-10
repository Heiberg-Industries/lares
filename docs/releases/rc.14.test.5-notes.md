# rc.14.test.5 release notes

**This is a test release, not rc.14.** It is rc.14.test.4 with one fix that blocked the agent
mailbox on every real install, plus the rest of the Connections pages. Do not use it for an
installation you depend on. Its record is `releases/2026-11-10-rc.14.test.5.json`. The name
deliberately differs from the usual date, `rc.` and number, so that nobody following the install
guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `34dbf2c21e2c4dc918baba75ca0aa7d658165825`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.test.4.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.14.test.4

- **The keeper can see the Google files its settings name.** The install guide's Google step writes
  the paths of the Google sign-in files into the keeper's settings, but the keeper was never given
  those files. So once Google was set up, the keeper refused every restart or change of a chief of
  staff with Gmail permission, and the agent was left waiting with "Apply failed; previous
  definition restored but runtime recovery failed". The agent itself kept running on its old
  software. Now:
  - the installer gives the keeper exactly those files, read only, and nothing else;
  - it stops with a plain message, before changing anything, when a named file is missing, is not
    a plain file owned by root, or is outside the server's secrets folder;
  - the same applies to the Microsoft files.
- **Clearer messages when an agent does not move to a new release.** The keeper names a Google or
  Microsoft file it cannot see. `lares agent refresh` now says "the keeper reported an error" for an
  error, and keeps "could not confirm the restart in time" for a real timeout.
- **One page per Integrations card.** Each shared service has its own page:
  - which agents use it, when it was last used, and where its key is kept;
  - what each agent may do with it, with the same controls as before;
  - for Notion: its key, sync and proposals; for the Readability worker: saved links.

  A read-only Outside tools page lists each agent's outside tool servers and whether their keys are
  in place. The old "Integration details" page is gone.
- **Your accounts** says what is wrong with an account in its own words, the Google row reads
  "Gmail, Calendar and Drive", and mailboxes from the removed e-mail door can be removed there by
  the owner.
- **The agent's mailbox line** on its Access tab has the new look: "Works on <address> ▾" opens a
  menu, and "Connect Google" opens a small dialog.
- **The install guide** says to switch on the Gmail, Calendar and Drive APIs in the Google Cloud
  project and lists the five consent-screen scopes. A one-command live check,
  `services/chief-of-staff/tests/live/agent-mailbox-all.live.mts`, signs in to Google once and
  checks drafts, Drive and calendar events.

Nothing in the database changed; the newest file is still `036_agent_account_bindings.sql`.

## Before you update

The same as for [rc.14.test.4](rc.14.test.4-notes.md): the Google Cloud project needs the three
APIs and five scopes, and an agent with an e-mail door must have it removed first.

## Upgrading

`lares update --release 2026-11-10-rc.14.test.5` updates a server on rc.14.test.4, rc.14.test.3,
rc.14.test.2, rc.14.test.1 or rc.13.test.5.

**A server where an agent was left waiting by rc.14.test.4:** the update gives the keeper the Google
files, but skips that agent, because it is waiting. Open it in the console and press **Apply
changes**; it then moves to this release.

A server on rc.12 or earlier still cannot update; install fresh by following
[the install guide](../install.md).

## How it was tested

- Installer tests cover the new mounts: exact read-only files, nothing when no Google or Microsoft
  setting exists, a refusal for each bad file before anything changes, and the keeper recreated when
  the mounts appear.
- The workflow that published these images ran the real-install proof on the same commit, including
  a chat after `lares update`. Its limits are unchanged: stand-in model and sign-in providers, its
  own images built from the same source, backups on the same machine, one person. **It does not
  run the Google setup step**, so the fix above is covered by the installer tests and the test
  server, not by the proof.

**Not tested anywhere yet:** the agent mailbox on a real install (the test this release is for), and
the list in [the rc.14.test.1 notes](rc.14.test.1-notes.md).

## Known faults and limits

- When an apply fails, the console shows only that it failed and that the previous definition was
  restored, not the file the keeper named.
- Disconnecting an account in Lares does not withdraw its permission at Google.
- Everything listed in [the rc.14.test.3 notes](rc.14.test.3-notes.md) still applies.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-10
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

The high and critical counts are the same as for rc.14.test.4, image by image. Only the totals were
compared. The scanner's database now marks more findings "unknown" severity; those are not counted
here.

## How it was published

One manual run of each image workflow on the same commit, all of which passed the first time:
- keeper and agents: run 42768235244, including the real-install proof;
- console: run 42768263202;
- sync jobs: run 42768293057.
