# rc.14.test.1 release notes

**This is a test release, not rc.14.** It carries the first half of rc.14 and tests `lares update`
from rc.13.test.5. Do not use it for an installation you depend on. Its record is
`releases/2026-11-06-rc.14.test.1.json`. The name deliberately differs from the usual date, `rc.` and
number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `db35374afcaa4f65f5e23ec26c018303c78ee8b5`. The database image, the gateway and the proxy in front of the console are the
same as in rc.13.test.5.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

## What changed since rc.13.test.5

**Models and spending**

- The included gateway can serve a different model per purpose: writer, utility and gate, beside the
  main model. They are optional lines in `etc/lares/installation.env` (`LARES_MODEL_WRITER`,
  `LARES_MODEL_UTILITY`, `LARES_MODEL_GATE`) or `install.sh` flags on a first install, and must use the
  same provider as `LARES_MODEL`.
- The included gateway can serve one embedding model with its own key (`LARES_EMBED_MODEL`,
  `LARES_EMBED_BASE_URL`, `LARES_EMBED_MAX_INPUT_TOKENS`, key in `etc/lares/secrets/embed-provider-key`).
- `lares budget setup` prices every model the gateway serves. The owner's agent gets a key per model.
  Scheduled jobs and tools that call a model outside a conversation (the morning brief, email
  sorting, voice learning) can use the extra models and embeddings; the cost goes to the
  installation owner's own monthly limit.
- **An agent can pay for its model calls with its own provider key.** On the server:
  `sudo lares agent provider-key set <agent> --key-file <path>`, and
  `sudo lares agent provider-key remove <agent>`. The gateway then uses that key for that agent's chat
  calls only; embeddings always use the installation's key. A missing or unusable key file is refused
  plainly and never falls back to the installation key. There is no console page for this yet.
- When a monthly spending limit is reached, Slack, Telegram, scheduled jobs and web chat say which
  limit and when it resets, instead of reading like a broken setup. Web chat keeps the conversation
  and the typed text. The installation's own limit is never shown as an amount.

**Settings without hand edits**

- `lares doctor` has a new check, "Matches the release". It fails when a Lares service runs an image
  other than the installed release's digest, when an extra service runs in the Lares compose
  projects, or when `keeper.json` holds a setting that neither the installer nor a shipped Lares
  command wrote. Only paths and service names are printed, never values.
- Console → Settings has a place for the Notion meetings database and for eight chief-of-staff
  settings that used to need a hand edit of `keeper.json` (brands, commercial brands, institutional
  sender domains, the CRM organisation-number field, where articles are filed and others). An
  installer re-run keeps them, and also keeps agent settings that were set by hand.
- `lares agent import <dir>` brings existing agent folders (`agent.json`, `duties.md`, `voice.md`)
  onto a fresh install as data, with the same checks as creating an agent in the console.

**Vault and scheduled jobs**

- On an engine-image install, scheduled jobs can read and save Vault notes again, through the keeper
  and with the same checks as a tool call: the nightly memory job, clippings, and the digest. The
  digest files plain notes and saved links as articles. Attachments still stay in the inbox.
- The Notion sync can run as an optional service the keeper manages. It is off until the owner
  switches it on in Console → Settings → Notion sync and accepts a preview of the first run. This
  release covers the attendees and people passes only.

**Fixes**

- After a reboot, agents come back by themselves; before, they stayed off until someone ran
  `sudo lares agent start`.
- The chat page says when the agent is not running and shows the start command. A refused tool call
  no longer stays "running".
- A permission switched to "never" takes effect on the very next decision, instead of up to 30
  seconds later.
- zod and qs are moved past their security advisories.

The database gains one file, `035_agent_provider_keys.sql` (which agent has its own key; it holds no
secret).

## How it was tested

The workflow that published these images also ran the real installer on a clean CI server, from an
ordinary folder, and used it: owner sign-in, `lares budget setup`, a chat whose tool call came back
with its caller, an approved card that wrote a file and a private Vault note, every model call
settled in the spending ledger, and a backup restore rehearsal. It then built the software a second
time and ran `lares update` to it after `lares backups`: the update saw the proven backup and took
its own, the server ran the second build, the running agent moved to it, and data and sign-in
survived. New in this release, the same run also checked that:

- `lares doctor`'s "Matches the release" check passes on the fresh install, and fails naming the
  setting when a `keeper.json` key is set by hand;
- a fresh install has no Notion sync container, and switching the sync on starts nothing until a
  preview is accepted;
- after a reboot the agent comes back without `lares agent start`.

The gateway proof ran an agent's own provider key against both gateways with a stand-in provider:
the key is used without a restart, rotation takes effect at once, unusable key files are refused
without any call going out and without falling back to the installation's key, embeddings never
carry the agent's key, and the key never shows up in logs.

The line "is held: the budget authority check refused", seen once in an earlier CI run, did not
appear in this run.

**That proof has the same limits as before.** The model provider and the sign-in provider are
stand-ins, it builds its own images from the same source, backups go to the same machine, and it
uses one person only.

**Not tested anywhere yet:**

- a power cut on this release (rc.13 found two faults; the reboot fix above is meant to close one)
- a second member and member isolation
- a real spending-limit refusal
- a real month change
- an agent's own provider key against a real provider
- restoring onto a new server

## Known faults and limits

Everything listed under known faults in [the rc.13.test.5 notes](rc.13.test.5-notes.md) still
applies, apart from the faults fixed above. Also:

- **After `lares update` to this release, every model call is refused** ("I could not verify
  permission to spend"; web chat says "This conversation is unavailable"). Found on a test server
  after the update. The update rewrites the gateway's code and settings but leaves the running
  gateway alone, so it keeps the previous release's code. `lares doctor` does not notice. Fixed for
  the next test release. A fresh install of this release is not affected.
- There is no console page yet for an agent's own provider key; it is set from the server only.
- The Notion sync does not yet write to the Vault (wiki, desk and transcripts come later).
- Importing an existing Vault (`lares vault import`) is not in this release.
- In one earlier CI run of the real install, the keeper logged "proof-agent is held: the budget
  authority check refused" and at once "no longer held"; chat still worked. It did not happen in the
  run that published this release.

## Upgrading

`lares update --release 2026-11-06-rc.14.test.1` updates a server on rc.13.test.5. A server on rc.12
or earlier still cannot update; install fresh by following [the install guide](../install.md).

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-06
against each final linux/amd64 image immediately before it was published. The published digests were
not scanned a second time.

| Image | Critical | High |
|---|---|---|
| console | 1 | 34 |
| keeper | 3 | 72 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 34 |
| chief-of-staff runtime | 1 | 47 |
| creative runtime | 1 | 47 |
| sync jobs | 1 | 47 |

**Every finding from rc.13.test.5 is still there, and there are new high findings.** No critical
finding is new. The new ones are all in Debian 12 system libraries whose installed versions have not
changed since rc.13.test.5; the advisories were published since, and Debian offers no fixed version
yet:

| Advisory | Package | In |
|---|---|---|
| CVE-2026-85091 | zlib1g 1:1.2.13.dfsg-1 | every image except the egress proxy |
| CVE-2026-76844 | zlib1g 1:1.2.13.dfsg-1 | every image except the egress proxy (the scanner's title for it names a different project; recorded as reported) |
| CVE-2026-113351 | libexpat1 2.5.0-1+deb12u5 | keeper, both agent runtimes, sync jobs |
| CVE-2026-115506 | libexpat1 2.5.0-1+deb12u5 | keeper, both agent runtimes, sync jobs |
| CVE-2026-119374 | libsqlite3-0 3.40.1-2+deb12u2 | keeper |
| CVE-2026-119379 | libsqlite3-0 3.40.1-2+deb12u2 | keeper |

None of these has been assessed for this test release. The older findings are named in
[the rc.13.test.2 notes](rc.13.test.2-notes.md) or an earlier release's notes.
