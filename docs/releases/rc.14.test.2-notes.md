# rc.14.test.2 release notes

**This is a test release, not rc.14.** It is rc.14.test.1 with one fix: after `lares update`, the
model gateway kept running the previous release's code, so every model call was refused. Do not use
it for an installation you depend on. Its record is `releases/2026-11-07-rc.14.test.2.json`. The
name deliberately differs from the usual date, `rc.` and number, so that nobody following the
install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `e6da9714a128359db5e457b3362b9e0d4f5a0471`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.test.1.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.14.test.1

- **An update restarts the gateway onto its new files.** `lares update` (and any installer re-run on
  a server whose gateway already exists) rewrites the gateway's start script, code and configuration
  and then recreates the gateway container, so it runs the new files. Before, the running gateway
  kept the previous release's files: after an update from rc.13.test.5 to rc.14.test.1 it refused
  every model call ("I could not verify permission to spend"; web chat said "This conversation is
  unavailable"). A fresh install still does not start the gateway; `lares budget setup` does, as
  before. If the gateway cannot be restarted, the installer stops and says so.
- **`lares doctor` notices a container that runs replaced files.** The "Matches the release" check
  fails when a Lares container still reads a file that was replaced on the server since the
  container started, and names the container and the files. Run without sudo, it cannot look and
  says so as a warning instead.

- **CI runs on Ubuntu 24.04 by name.** The publishing machines now run Ubuntu 24.04 by name, not "the
  latest Ubuntu". When that moved to Ubuntu 26.04 (Docker 29.4), the check that an agent reaches
  an outside tool through the network guard timed out there, and the first try at this release
  stopped. That is not understood yet. Ubuntu 26.04 is not on the tested path; servers on Ubuntu
  24.04 are what these images are proven on.

Nothing else in the software changed. The database has no new file; the newest is still `035_agent_provider_keys.sql`.

## How it was tested

The workflow that published these images ran the same real-install proof as for rc.14.test.1: a
clean CI server, the real installer from an ordinary folder, owner sign-in, `lares budget setup`, a
chat with a tool call, an approved card, every model call settled in the spending ledger, a backup
restore rehearsal, then a second build and `lares update` to it. New in this release, after that
update it checks that the gateway reads none of the replaced files.

That proof has the same limits as before: stand-in model and sign-in providers, its own images
built from the same source, backups on the same machine, one person.

**Not tested anywhere yet:** the same list as in [the rc.14.test.1 notes](rc.14.test.1-notes.md):
a power cut, a second member, a real spending-limit refusal, a real month change, an agent's own
provider key against a real provider, restoring onto a new server.

## Known faults and limits

Everything listed in [the rc.14.test.1 notes](rc.14.test.1-notes.md) still applies, apart from the
gateway fault fixed above. Also:

- The proxy in front of the console (Caddy) is not reloaded when an installer re-run rewrites its
  configuration. That file only changes with the domain or the engine's own routes, so this is
  unlikely to matter on an update between test releases, but it is the same kind of fault.
- `lares update` prints the Vault backup plan twice during its backup step.
- In the run that published this release, one of the gateway proof's 68 cases failed once
  ("Cannot warm native authentication", right after the case that blocks and unblocks a key) and
  passed when the two agent-image jobs were run again. It passed in every earlier run. It looks like
  a timing race inside the proof, not a fault in the release; it is recorded so that a second
  occurrence is recognised.

## Upgrading

`lares update --release 2026-11-07-rc.14.test.2` updates a server on rc.14.test.1 or rc.13.test.5.
On a server already on rc.14.test.1 with a stuck gateway, this update also restarts it. A server on
rc.12 or earlier still cannot update; install fresh by following [the install guide](../install.md).

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-07
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

**Every finding from rc.14.test.1 is still there, and one more is rated high.** No critical finding
is new, and no package changed version. CVE-2026-78661 (golang.org/x/net v0.58.0, inside the
`docker-compose` plugin the keeper image carries) was already reported for rc.14.test.1 without a
rating; the scanner now rates it high. The fixed version is 0.62.0, which needs a newer Docker
Compose. It has not been assessed for this test release. The older findings are named in
[the rc.14.test.1 notes](rc.14.test.1-notes.md) and earlier releases' notes.
