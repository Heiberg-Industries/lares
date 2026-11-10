# rc.14 release notes

rc.14 follows rc.12 (`releases/2026-10-21-rc.12.json`) and is recorded in
`releases/2026-11-10-rc.14.json`. There was no finished rc.13: its work was tested as rc.13.test.1 to
rc.13.test.5 and carried into rc.14, which was tested as rc.14.test.1 to rc.14.test.7. These notes
gather everything since rc.12 in one place. The test-release notes in this folder give the detail
and the order things happened in.

**rc.12 or earlier cannot update to rc.14 in place.** A server on rc.12 or earlier gets a fresh
rc.14 install, and its agents and notes are brought across (see [Moving from rc.12 or
earlier](#moving-from-rc12-or-earlier)).

## What it is built from

rc.14 uses exactly the images of rc.14.test.7, by the same digests. The console, keeper, egress
proxy, firewall helper, both agent images and sync jobs were built from commit
`04c94594f0669bff6668b77337893ee5298a6a65`. Between that commit and this record, main changed only
release records. This record also changes the example release name in the two install guides; the
copies inside the agent images keep the rc.12 example until the next build. The database image, the
gateway and the proxy in front of the console are unchanged since rc.12.

Because the images were built for a test release, the public documentation inside the agent images
identifies itself as `candidate`, not as `2026-11-10-rc.14`. That is the label of the build, not a
different build (see [the public documentation corpus](../public-docs-corpus.md)).

A fresh install applies the database files up to `036_agent_account_bindings.sql` in
`services/box/sql/`. There is no file numbered `010`.

## What changed since rc.12

### Members, sign-in and accounts

- **Members.** Each person has their own sign-in, sessions and invitations, and permissions on the
  agents they share.
- **Your accounts.** Every member connects their own Google and Microsoft accounts on one page,
  which says in plain words what is wrong with an account. Disconnecting in Lares does not withdraw
  the permission at Google; do that in your Google account too.
- **Integrations.** The owner has a searchable grid of the shared services. Each service has its
  own page: which agents use it, when it was last used, where its key is kept, and what each agent
  may do with it. A read-only Outside tools page lists each agent's outside tool servers and whether
  their keys are in place.

### The chief of staff's mailbox

- **The agent works on a mailbox you choose:** one of your own Google accounts, connected with the
  permission "Read mailbox, calendar and Drive files, write drafts, and add or change calendar
  events (each one approved by you)", chosen on the agent's Access tab. Only the agent's owner can
  choose, and only from their own accounts. A reconnect or a change of owner stops the agent using
  it until you press Confirm.
- **With that mailbox the agent** sorts new mail and writes reply drafts in Gmail, reads a Google
  Docs, Sheets or Slides link you send it, and adds, changes or deletes calendar events, each after
  you press Approve. **It never sends.** Sending is refused in Lares even though Google's draft
  permission could send.
- **Reply drafts stay in the Gmail conversation.** The thread, reply headers and "Re:" subject come
  from the original email, not from the model.
- **Briefs, triage, voice learning and the other mail readers** all use the chosen mailbox and
  nothing else.
- **The e-mail door is removed** (see [What breaks](#what-breaks)).

### Web chat for an agent's owner

When the person in web chat is the agent's owner, the agent can read the chosen mailbox and its
calendar there. The owner check runs when the conversation starts and again before every action, and
anyone else keeps the read-only set. Drafts, Docs links and calendar changes are not yet available
in web chat (see [Known limits](#known-limits)).

### Spending and models

- **Member budgets** are enforced through the included gateway. `sudo lares budget setup` prices
  every model the gateway serves.
- **A model per purpose.** Beside the main model, the gateway can serve a writer, a utility and a
  gate model (`LARES_MODEL_WRITER`, `LARES_MODEL_UTILITY`, `LARES_MODEL_GATE`), all from the same
  provider, and one embedding model with its own key (`LARES_EMBED_MODEL`, `LARES_EMBED_BASE_URL`,
  `LARES_EMBED_MAX_INPUT_TOKENS`). Scheduled jobs and tools that call a model outside a conversation
  can use them; the cost goes to the installation owner's own monthly limit.
- **An agent can pay with its own provider key**, set on its Access tab or with
  `sudo lares agent provider-key set <agent> --key-file <path>`. The key is used for that agent's
  chat calls only, is never shown again and is not tested when saved; a missing or unusable key is
  refused plainly and never falls back to the installation's key. Embeddings always use the
  installation's key.
- **A reached limit says so** on Slack, Telegram, scheduled jobs and web chat: which limit and when
  it resets. Web chat keeps the conversation and the typed text.
- **The money ledger holds up.** A new month opens by itself; the ledger carries on past one file;
  overlapping calls wait their turn; a call that never gets a final cost counts only in the month it
  began; spending survives database restarts and stalls and a killed keeper. `lares budget recover`
  lifts a freeze once the records agree.

### Notes, Vault and Tracks

- **Vault areas** with access checks, and erasure of a person's data.
- **`lares vault import <folder>`** brings an existing folder of notes into the Vault: a preview
  first, then exactly the confirmed plan; safe to run again. See
  [the runbook](../runbooks/vault-import.md).
- **Scheduled jobs save to the Vault again** on an engine-image install, through the keeper and with
  the same checks as a tool call: the nightly memory job, clippings and the digest.
- **A private note from web chat**, one approval card per note.
- **Tracks** replace the fixed CRM with work you define.

### Agents

- **`sudo lares agent import <dir>`** brings existing agent folders (`agent.json`, `duties.md`,
  `voice.md`) onto a fresh install, with the same checks as the console's new-agent page.
- **Agents come back after a reboot by themselves.**
- `sudo lares agent start <name>` and `sudo lares agent refresh` replace manual steps. An agent left
  waiting after a failed apply can be applied again from its edit page.
- A permission switched to "never" takes effect on the very next decision.
- Your accounts and the integration pages show agents by their display name.

### Settings without hand edits

- Console → Settings holds the Notion meetings database and eight chief-of-staff settings that used
  to need a hand edit of `keeper.json`. An installer re-run keeps them.
- **The Notion sync** can run as an optional service the keeper manages. It is off until the owner
  switches it on in Console → Settings → Notion sync and accepts a preview of the first run. It
  covers the attendees and people passes.

### Outside tools

Outside tools are set up from the console, with their credentials held by the keeper and an approval
for each exact action.

### Installing, updating and checking

- **Separate database accounts.** The administrator password is kept away from running services,
  and services must pass a maintenance check to start. An update gives each database login exactly
  the permissions the release lists, and stops if it finds more.
- **`lares doctor`** has two new checks. "Matches the release" fails when a Lares service runs an image
  other than the release's, an extra service runs, a container reads a file replaced since it
  started, or `keeper.json` holds a setting no shipped command wrote. "Database permissions" fails
  when a login's permissions differ from the release's.
- **`lares update`** sees a backup that `lares backups` verified, takes its own, downloads the new
  images before it switches, moves running agents onto the new release, restarts the gateway onto
  its new files, and accepts `--release-file <path>`.
- The installer finishes from any folder; `sudo lares owner-bootstrap` sets up the first owner.
- When the keeper restarts a chief of staff with Google access, it sees only the Google (and
  Microsoft) files its settings name, read only. The installer refuses a missing, linked or
  wrongly owned file before it changes anything.

### Dependencies

`undici` is upgraded, `happy-dom` is out of the images, and `zod` and `qs` are past their advisories.

## What breaks

- **No in-place update from rc.12 or earlier.** `lares update` refuses such a server before
  changing anything. It has none of the separate database accounts or maintenance state rc.14
  needs, and rc.14 does not take over a database it did not set up.
- **The e-mail door is gone.** Agents no longer get a mailbox from the server's settings. A
  definition that still has an `email` door is refused with a plain finding, and the agent keeps its
  last valid definition. Delete the door from `agent.json` first, then choose the mailbox on the
  agent's Access tab.
- **The Google Cloud project needs more.** Switch on the Gmail API, the Google Calendar API and the
  Google Drive API, and list `gmail.readonly`, `gmail.compose`, `calendar.readonly`,
  `calendar.events` and `drive.readonly` on the consent screen. A project of type External still in
  "Testing" makes Google expire the agent's access after 7 days; use an Internal Workspace project
  or an External project in production. An account connected earlier with read access only cannot
  be chosen.
- **Only the included gateway** on a fresh install. There is no installer choice for an external
  gateway.

## Moving from rc.12 or earlier

1. Take and verify a backup of the old server, and keep the old server as it is until the new one
   works.
2. Install rc.14 on a fresh server by following [the install guide](../install.md), with release
   name `2026-11-10-rc.14`.
3. Copy each agent's folder across, delete any `email` door from its `agent.json`, raise the agent
   limit in Settings → Agents, and run `sudo lares agent import <dir>`. Agents whose role is no
   longer part of the engine (for example `travel`) are refused by name; keep their folders as data.
4. Copy the notes folder across and run `sudo lares vault import <folder>`, preview first.
5. Set up the chief of staff's Google client and choose its mailbox (section 8 of the install
   guide), reconnect the chat doors from the console, and enter settings in Console → Settings.

Conversations, spending history and members do not come across.

## Updating from a test release

`lares update --release 2026-11-10-rc.14` updates a server on any rc.14 test release or on
rc.13.test.5. From rc.14.test.7 the images are the same, so only the release name changes. From
earlier test releases, see the notes of each release in between, in particular
[rc.14.test.4](rc.14.test.4-notes.md) for the Google project and the e-mail door. An agent that an
earlier test release left waiting is skipped by the update: open it, choose **Edit agent** and press
**Apply connection changes**.

## How it was tested

**In CI, on the commit these images were built from** (run 42885904795): the real installer on a
clean server from an ordinary folder. It covers owner sign-in, `lares budget setup`, a chat whose
tool call carries on, an approved card that writes a file and a private note, every model call
settled in the ledger, and a backup restore rehearsal. Then a second build and `lares update` to it,
with a chat after the update. It also checks "Matches the release", that the Notion sync starts
nothing before a preview is accepted, and that the agent comes back after a reboot. Its limits:
stand-in model and sign-in providers, images built from the same source, backups on the same
machine, one person, no Google setup step and no agent left waiting.

**On a real test server** updated, with its data kept, from rc.13.test.2 through every rc.14 test
release to these exact images:

- every update, with `lares doctor` reporting nothing failed, including "Matches the release";
- an unplanned host reset, after which every container, the agent included, came back unaided;
- an agent's own provider key against a real provider: with that key disabled at the provider,
  the agent's next chat was refused, so there is no silent fallback to the installation's key;
- the Google client set up as in the install guide, the keeper given its files, an account
  connected with "read + drafts" and chosen as the agent's mailbox;
- web chat reading the latest mail and the calendar for the agent's owner;
- by hand against real Google, through the same code the agent uses: a draft created, read back and
  deleted (nothing sent), a Doc read, and a calendar event added, changed and deleted.

**Not tested anywhere yet:**

- a fresh install of these images on a real server (the test server was updated, not installed
  fresh; CI installs fresh from the same source);
- `lares agent import` and `lares vault import` on a real install;
- drafts, Docs links and calendar changes through Telegram or Slack against real Google;
- the Notion sync against a real Notion workspace;
- a second member and member isolation;
- a real spending-limit refusal;
- a real month change;
- a planned power cut on rc.14;
- restoring onto a new server;
- live checks with real Microsoft accounts;
- servers on Ubuntu 26.04, which is not on the tested path.

## Known limits

- **Web chat cannot write drafts, open links or change calendar events**, even for the agent's
  owner. Each needs an approval card, which web chat cannot prepare yet for these tools, so the
  agent says the tool "was refused". Use Telegram or Slack for these; scheduled triage writes drafts
  as before. Reading mail and the calendar works in web chat.
- **Web chat shows tool-call lines, raw tables and quote marks** instead of formatted text.
- **When an apply fails**, the console shows only that it failed and that the previous definition
  was restored, not the file the keeper named.
- **Disconnecting an account in Lares does not withdraw its permission at Google.**
- **The Notion sync does not write to the Vault** (wiki, desk and transcripts come later).
- **Selective import from an older installation can only preview.**
- **Memory.** One chief of staff used about 2.6 GB on the test server (measured once). Two agents
  on a server with 8 GB leave little room; plan memory before starting a second agent.
- **The proxy in front of the console is not reloaded** when an installer re-run rewrites its
  configuration. That only changes with the domain or the engine's own routes.
- **`lares update` prints the Vault backup plan twice.**
- **Carried over from the rc.13 test releases** (see [rc.13.test.2](rc.13.test.2-notes.md#known-faults-and-limits)):
  - a refusal can reach the agent as "Vault reader unavailable";
  - track rules are checked only after approval;
  - a failed approved action can leave its card on "Waiting for the agent";
  - a message sent while the agent is answering appears lost;
  - a backup older than the latest spending leaves spending off after a restore;
  - a key action interrupted just after its money step needs checking by hand;
  - an unfinished call holds its amount until the month ends;
  - a final cost above the reservation freezes the installation;
  - calls running at midnight belong to the old month;
  - the ledger grows by about 24.5 KB per call and is never trimmed.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, high and critical findings only, run by CI on 2026-11-10
against each of these linux/amd64 images immediately before it was published as rc.14.test.7. The
published digests were not scanned a second time.

| Image | Critical | High | rc.12 (critical / high) |
|---|---|---|---|
| console | 1 | 34 | 1 / 56 |
| keeper | 3 | 129 | 2 / 79 |
| egress proxy (Alpine 3.24) | 0 | 0 | 0 / 0 |
| firewall helper | 1 | 34 | 1 / 56 |
| chief-of-staff runtime | 1 | 103 | 1 / 68 |
| creative runtime | 1 | 103 | 1 / 68 |
| sync jobs | 1 | 103 | 1 / 68 |

**Gone since rc.12:** `undici` and `happy-dom` (rc.13.test.2). The console and firewall helper
have fewer findings.

**New since rc.12.** All are in Debian 12 system libraries or Go modules whose installed versions
did not change, with no fixed version offered yet:

- SQLite (CVE-2025-7458, critical, in the keeper; CVE-2026-11822, CVE-2026-11824, CVE-2026-119373,
  CVE-2026-119374, CVE-2026-119379);
- Python 3.11 in the keeper (CVE-2026-7210, CVE-2026-11940);
- expat (CVE-2026-117610, CVE-2026-118370, CVE-2026-113351, CVE-2026-115506);
- zlib (CVE-2026-85091, CVE-2026-76844);
- `golang.org/x/net` in the keeper's Docker Compose plugin (CVE-2026-78661; fixed in 0.62.0, which
  needs a newer Docker Compose);
- ten Kerberos advisories, each counted once for four library packages (CVE-2026-71199,
  CVE-2026-71200, CVE-2026-107364, CVE-2026-112315 to CVE-2026-112320, CVE-2026-118380).

Between test releases the scanner's database also rated more existing findings high; that, not a
package change, accounts for most of the growth in the keeper, agent and sync job images.

**These findings have not been assessed one by one for rc.14.** Only the Kerberos findings were
compared finding by finding (chief-of-staff image, against rc.14.test.6). The findings accepted for
rc.10 and rc.12 are accepted again on the reasons given in [the rc.10 notes](rc.10-notes.md#accepted-findings)
and [the rc.12 notes](rc.12-notes.md#security-scan). The base image is reviewed again before v0.1.0.

## How it was published

One manual run of each image workflow on commit `04c9459`, for rc.14.test.7, all of which passed the
first time:

- keeper and agents: run 42885904795, including the real-install proof;
- console: run 42885935469;
- sync jobs: run 42885920569.

Nothing was published for rc.14 itself; this record names the same digests.
