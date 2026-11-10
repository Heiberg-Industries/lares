# rc.14.test.7 release notes

**This is a test release, not rc.14.** It is rc.14.test.6 plus web-chat tools for an agent's owner
and a few console fixes. Do not use it for an installation you depend on. Its record is
`releases/2026-11-10-rc.14.test.7.json`. The name deliberately differs from the usual date, `rc.`
and number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `04c94594f0669bff6668b77337893ee5298a6a65`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.test.6.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.14.test.6

- **In web chat, the agent's owner gets more.** When the person chatting with a chief of staff is
  that agent's owner, the agent can now:
  - write reply drafts in the mailbox chosen on its Access tab (never sent);
  - read Google Docs links;
  - read that mailbox's calendar.

  The agent checks who is chatting when the conversation starts and again before every action;
  anyone else keeps the previous, read-only set. Adding, moving or deleting calendar events from
  web chat is not in this release; on Telegram and Slack it works as before.
- **Integrations:**
  - the Model gateway card takes its status from the gateway itself, so it reads Enabled on an
    installation that uses it;
  - "Built in for" names services in words ("Notion sync").
- **Agent names:** Your accounts and the integration pages show the agent's display name instead of
  its internal name.
- **Your accounts:** "Used by" sits on its own line.

Nothing in the database changed.

## Upgrading

`lares update --release 2026-11-10-rc.14.test.7` updates a server on any earlier rc.14 test release
or on rc.13.test.5. After updating, start a new conversation in web chat so the agent offers the new
tools.

## How it was tested

- The new owner check has tests:
  - the owner gets the tools the agent is granted;
  - another member, or an owner check that fails, gets none;
  - ownership that changes mid-conversation is refused before any Google call;
  - calendar event changes stay refused in web chat.
- The workflow that published these images ran the real-install proof on the same commit; its
  limits are unchanged (see [the rc.14.test.5 notes](rc.14.test.5-notes.md)).
- **Not tested anywhere yet:** these tools through a real web chat against real Google (the test
  this release is for), and the list in [the rc.14.test.1 notes](rc.14.test.1-notes.md).

## Known faults and limits

The same as [rc.14.test.6](rc.14.test.6-notes.md). Calendar event changes from web chat come in a
later release.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-10
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 34 |
| keeper | 3 | 129 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 34 |
| chief-of-staff runtime | 1 | 103 |
| creative runtime | 1 | 103 |
| sync jobs | 1 | 103 |

**The high count rose by 40 in the keeper, both agent images and sync jobs, with no change to any
package.**
- For the chief-of-staff image the findings were compared one by one with rc.14.test.6. All 40 are
  10 Kerberos weaknesses new to the scanner's database (CVE-2026-71199, CVE-2026-71200,
  CVE-2026-107364, CVE-2026-112315 to CVE-2026-112320 and CVE-2026-118380; those with a date were
  published on 9 November). Each is counted once for each of the four Kerberos library packages
  (`libkrb5-3`, `libk5crypto3`, `libkrb5support0` and `libgssapi-krb5-2`, version
  `1.20.1-2+deb12u5`, the same version as in rc.14.test.6).
- Debian has no fixed version yet.
- No finding disappeared and none changed severity.
- The other three images show the same +40, but were not compared one by one.

Critical counts are unchanged.

## How it was published

One manual run of each image workflow on the same commit, all of which passed the first time:
- keeper and agents: run 42885904795, including the real-install proof;
- console: run 42885935469;
- sync jobs: run 42885920569.
