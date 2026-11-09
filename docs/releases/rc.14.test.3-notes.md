# rc.14.test.3 release notes

**This is a test release, not rc.14.** It is rc.14.test.2 with one fix: a server that was installed
before rc.14 and then updated refused every chat, because nobody could read the table rc.14 added.
Do not use it for an installation you depend on. Its record is
`releases/2026-11-08-rc.14.test.3.json`. The name deliberately differs from the usual date, `rc.` and
number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `a3652e5344d5b5b980f0e9c501a95e9dcf69c939`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.test.2.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.14.test.2

- **An update gives the database logins the permissions a new table needs.** Until now only a fresh
  install handed out those permissions; `lares update` added new tables but gave no login access to
  them. rc.14 is the first release since the logins were split that adds a table (the agents' own
  provider keys), so on a server updated from rc.13.test.5 the spending check could not read it and
  every chat was refused ("I could not verify permission to spend"). After its migrations, an update
  now gives each login exactly the permissions this release lists, and nothing beyond them. If the
  database holds a permission the release does not expect, the update stops, changes nothing about
  the permissions, and says so. The next `lares update` repairs an affected server by itself.
- **`lares doctor` checks the database permissions.** A new "Database permissions" check fails when
  a login's permissions differ from what the release lists. Before, a server in this state showed
  every check as passing. It needs `sudo`; without it the check says it cannot look.

Nothing else in the software changed. The database has no new file; the newest is still
`035_agent_provider_keys.sql`.

## How it was tested

A new database test rebuilds the faulty state: a table added by an update, with no permissions. It
fails with the same error the test server logged ("permission denied for table
agent_provider_keys") and passes with the fix, and a second run reports the permissions as already
matching.

The workflow that published these images ran the same real-install proof as for rc.14.test.2,
which now also sends a chat after `lares update` and expects an answer. That proof still updates
between two builds of the same source, so it adds no table; the database test above is what covers
the fault fixed here.

That proof has the same limits as before: stand-in model and sign-in providers, its own images
built from the same source, backups on the same machine, one person.

**Not tested anywhere yet:** the same list as in [the rc.14.test.1 notes](rc.14.test.1-notes.md):
a power cut, a second member, a real spending-limit refusal, a real month change, an agent's own
provider key against a real provider, restoring onto a new server. An update from rc.13.test.5
straight to this release has only been tested on the test server, not in CI.

## Known faults and limits

Everything listed in [the rc.14.test.2 notes](rc.14.test.2-notes.md) still applies, apart from the
permissions fault fixed above.

## Upgrading

`lares update --release 2026-11-08-rc.14.test.3` updates a server on rc.14.test.2, rc.14.test.1 or
rc.13.test.5. A server on rc.12 or earlier still cannot update; install fresh by following
[the install guide](../install.md).

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

**The findings are exactly those of rc.14.test.2**: the same vulnerabilities in the same package
versions, image by image. They are named in [the rc.14.test.2 notes](rc.14.test.2-notes.md) and
earlier releases' notes.

## How it was published

The first try of the workflow that builds the keeper and agent images stopped before publishing
anything: GitHub answered the scanner's download with an error for a few minutes. Its failed jobs
were run again on the same commit and passed, including the real-install proof. The sync jobs image
was built twice; the second build hit the same download error and published nothing, so the image
recorded here is the first.
