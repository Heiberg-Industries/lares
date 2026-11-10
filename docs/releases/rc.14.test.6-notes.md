# rc.14.test.6 release notes

**This is a test release, not rc.14.** It is rc.14.test.5 with two fixes. Do not use it for an
installation you depend on. Its record is `releases/2026-11-10-rc.14.test.6.json`. The name
deliberately differs from the usual date, `rc.` and number, so that nobody following the install
guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `f120d14678e60651612f541aeba4968d4cbdcf95`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.test.5.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.14.test.5

- **An agent left waiting after a failed apply can be applied again.**
  - Before: on an installation where spending is switched on per agent, a waiting agent's spending
    read as not activated. Its edit page hid "Apply connection changes" and showed "Native budget
    activation is required", while `lares agent start` refused because the agent was waiting, so
    nothing could move it.
  - Now: a waiting agent shows that it is waiting and why, and the edit page offers **Apply
    connection changes (restarts agent)**. The overview page says "Changes are waiting: open Edit
    agent to apply them". `lares agent start` and `lares agent refresh` name that button.
  - No budget rule changed.
- **Reply drafts from chat stay in the Gmail conversation.** When the chief of staff replies to an
  email, the draft tool now takes the thread, the In-Reply-To and References headers and the
  "Re: …" subject from the original email itself, instead of leaving them to the model. An existing
  "Re:", "SV:" or "AW:" prefix is kept, never doubled. Scheduled e-mail triage uses the same code.

Nothing in the database changed.

## Upgrading

`lares update --release 2026-11-10-rc.14.test.6` updates a server on rc.14.test.5, rc.14.test.4,
rc.14.test.3, rc.14.test.2, rc.14.test.1 or rc.13.test.5. An agent that an earlier test release left
waiting is skipped by the update: open it in the console, choose **Edit agent** and press **Apply
connection changes**. The same steps as for [rc.14.test.4](rc.14.test.4-notes.md) apply to the
Google Cloud project.

## How it was tested

- The keeper, console and command-line tests cover a waiting agent under the spending guard, and the
  draft tool's tests cover the reply headers and subject.
- The workflow that published these images ran the real-install proof on the same commit; its limits
  are unchanged (see [the rc.14.test.5 notes](rc.14.test.5-notes.md)). It does not leave an agent
  waiting or run the Google step, so both fixes are first proven on the test server.
- **Not tested anywhere yet:** a reply draft against real Gmail, the agent mailbox on a real install,
  and the list in [the rc.14.test.1 notes](rc.14.test.1-notes.md).

## Known faults and limits

The same as [rc.14.test.5](rc.14.test.5-notes.md), apart from the two faults fixed above.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-10
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 34 |
| keeper | 3 | 89 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 34 |
| chief-of-staff runtime | 1 | 63 |
| creative runtime | 1 | 63 |
| sync jobs | 1 | 63 |

**The high count rose by 16 in the keeper, both agent images and sync jobs.** In each of those
images the scanner's "unknown severity" count fell by exactly 16 at the same time (keeper 22 → 6,
agents and sync jobs 17 → 1), and no change in this release adds a package. So these are most
likely findings the scanner's database has now rated high, not new packages. That is
an inference from the totals; the individual findings were not compared one by one. Critical counts
are unchanged.

## How it was published

One manual run of each image workflow on the same commit, all of which passed the first time:
- keeper and agents: run 42785310831, including the real-install proof;
- console: run 42785337753;
- sync jobs: run 42785350984.
