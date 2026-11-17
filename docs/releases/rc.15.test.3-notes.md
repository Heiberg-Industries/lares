# rc.15.test.3 release notes

**This is a test release, not rc.15.** It is the third test release on the new version of the agent
framework (`eve` 1.0, release candidate 10). Do not use it for an installation you depend on. Its
record is `releases/2026-11-17-rc.15.test.3.json`. The name deliberately differs from the usual date, `rc.`
and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed in the record were built from commit `f08f84a6f7b3ae46156597377caf87e5825a580b`.

Since rc.15.test.2 (commit `88e9d9a6860868e7ce92c54dfd2afd1063d2e6a6`) the code changed in one area
only: how agents list and search notes, in a chief of staff's web chat and on Slack and Telegram (see
"Listing and searching notes" below). The other change
since then is the record and notes of rc.15.test.2 itself.

What that change shows about the images (expected from the files each image is built from; the real
answer is the comparison of digests below):
- The database image is unchanged: no database file changed.
- The gateway image is the upstream LiteLLM image, which this project does not build. It is copied
  unchanged from the rc.15.test.2 record. No file of the program that runs inside the gateway changed
  since rc.15.test.2.
- The Keeper, the console and both agent images (chief of staff and creative) contain the changed code.
- The egress proxy, the firewall helper and sync jobs are built from files that did not change. They
  are expected to hold the same content as in rc.15.test.2. A publishing run builds all seven images,
  so their digests may still differ from rc.15.test.2's.
- The database, gateway and proxy in front of the console (Caddy) images are copied unchanged from the
  rc.15.test.2 record.

What the digests show: all seven images built in the three publishing runs have a different digest from
the one in the rc.15.test.2 record, including the egress proxy, the firewall helper and sync jobs, whose
input files did not change. Nobody compared what is inside those three images. The database, gateway and
Caddy digests are the same as in the rc.15.test.2 record.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

Model prices were last checked on 3 November 2026.

## Listing and searching notes

- **The note list no longer stops at 512 notes.** In a chief of staff's web chat the agent's list of
  notes failed once an area held more than 512 notes. It now returns one page at a time: at most 200
  notes the person may see, in order by name. Every page except the last holds 200 notes. When more
  follow, the answer carries a cursor, and the agent is told to ask for the next page with it. The agent can also ask for one
  folder only (for example `ventures`), which lists the notes in that folder and its subfolders.
- **Notes the person may not see do not show up in the count.** To build a page the Keeper reads the
  folder's notes and keeps only the ones the person may see before it cuts the page, so the cursor
  counts only notes the person can already see and says nothing about the others.
- **Hidden folders stay hidden.** Naming a folder only narrows the normal listing; a folder that the
  listing hides, such as `_meta`, is not reachable that way.
- **A chief of staff's web chat can now search notes.** In the private and in the shared area, a chief
  of staff's web chat offers the same keyword search that Slack and Telegram conversations use. The
  Keeper runs it and returns at most 50 note paths. When more than 50 notes contain every word searched
  for, it says so ("more"), and the agent is told to search again with more specific words. When no note
  contains every word, it returns at most 20 notes that contain the rarest of the words, without saying
  whether more did. A chief of staff's web chat instructions now name search and say to search instead
  of listing the whole area. A creative agent's web chat still has no note tools. Searching leaves out
  notes the person may not see before it scores and counts them, so such a note can no longer change
  which notes are found, and the number the search returns is the number of notes searched.
- **On Slack and Telegram the same two changes apply, for both roles.** Note search leaves out notes the
  person may not see before it scores and counts, and the list tool pages the same way (pages of at
  most 200, with a folder and a cursor), because both roles share these tools. The list there still
  shows every note in the area, including notes the person may not see, as before; only web chat leaves
  those out. For a person who may see every note, a search answers as before.
- **Descriptions.** The list tool's description now says how to page and to search instead of listing
  everything; the search description says what "more" means.
- **Two places that read a whole listing before now page through their own folder:** the tracks home and
  the check made before a new note is written.
- **What did not change.** There is no new database file, no database index and no change to the note
  format. A note that is a symbolic link, a hard link, or sits in a nested repository in the listed folder
  is still refused, and refuses the page.

## Mentions in a Slack channel (included from rc.15.test.2)

You can mention an agent in a Slack channel it was invited to. This replaces the rc.15.test.1
statement that mentioning an agent in a shared channel does not reach it.

- **Who can ask.** In a channel the agent answers only the people it answers in a direct message
  (usually just you). Everyone else in the channel can read its answers but cannot ask it anything.
- **What it can use there.** It answers from general knowledge and the public Lares pages. A chief of
  staff can also look up your contacts (when contacts are connected), deadlines and reminders, read-only,
  and everyone in the channel can read what it finds. A creative agent has no such lookups.
- **What it is not given there.** Your mail, your calendar, your notes and what you asked it to remember.
  It is told that it is in a shared channel and that everyone there reads its answers. A chief of staff
  is told only whether contacts are connected, and nothing else about what is connected.
- **What it does when you ask for more.** If you ask for something it can only do in a direct message, it
  tells you to write to it there. Anything that needs your approval has to be asked for in a direct
  message, never in the channel.
- **Private channels** count as channels here too. A conversation in a channel is stored and learned
  from the same way a direct message is.
- **A Slack app made from the console** asks for the bot permission `app_mentions:read` and the bot
  event `app_mention`, for both roles, and for nothing that lets it read other messages in a channel.
  The creative agent's app still does not ask for `im:write`. The console's Slack setup says how to
  use the agent in a channel.

### A Slack app made earlier needs two additions, a reinstall and an invitation

A Slack app made before rc.15.test.2 does not get the new permission and event by itself. In the app's
settings on Slack:
1. Add the bot permission `app_mentions:read` under OAuth & Permissions.
2. Add the bot event `app_mention` under Event Subscriptions.
3. Install the app to your workspace again.
4. Invite the app to the channel where you want to mention it.

The install guide gives the same steps. Without them, a mention in a channel is not expected to reach
the agent.

## Web chat (included from rc.15.test.2)

- **A chief of staff's web chat knows today's date.** A web chat conversation with a chief of staff is
  told today's date, as Slack and Telegram conversations already were, so "Friday" is worked out
  from today's date instead of guessed. Web chat still gets none of the owner's remembered facts.
- **Deadlines and reminders in web chat, for the agent's owner only.** In a chief of staff's web chat
  the agent's owner can list deadlines, add a deadline, restart a stopped deadline's reminders,
  dismiss a deadline (after approving a card) and list reminders. Someone who is not the agent's owner
  gets none of these in web chat. If a request to add a deadline or restart its reminders cannot be
  confirmed as coming from the agent's owner, the agent is told so and nothing changes. A shared Slack
  channel keeps only the two read-only lists.
- **A message typed while an approval card waits is answered.** The card nobody answered is withdrawn,
  and a card you already approved still runs. The agent also reads the new message and answers it,
  however long the card had been waiting. If the agent still cannot finish its reply, the red line says
  what was and was not done: that your new message cancelled what was waiting for your answer, whether
  your answer to another card was applied, and that you should send the message again.
- **Clearer wording on an answered card.** When one step shows two cards and you have answered one, the
  answered card says what happens next instead of "Waiting for the agent.": an approved card says it
  runs once the other card is answered or you send a new message, and a denied card says the agent goes
  on at that point. In a conversation that has ended, or where the page cannot answer or send, an
  answered card that is still open says only "You have answered this.", and the line below the
  conversation says why.
- **The note tool does not speak of a thumbs-up.** The agent's description of its note tool, and web
  chat's own instructions, say that once you approve the card, the note is saved, with no further step.
  New notes still land in the area's `_inbox` folder.

## Model provider and keys (included from rc.15.test.2)

- **A refused model call gives its room back at once.** When the model provider refuses a call with
  HTTP 401 or 403 (the answers for a key or a request it does not accept), the call is counted as
  costing nothing straight away, so the room it had set aside in the monthly spending limit is given back
  at once instead of being held until the month ends. The Keeper writes one line about it to its log,
  naming only the status. A 429, any 5xx, a timeout, a dropped connection, a cancelled call and the
  gateway's own refusals keep the room set aside. If the gateway's report of the refusal is
  lost, the room stays set aside.
- **`sudo lares doctor --test-model` checks the provider key.** On an installation with the built-in
  gateway it does not make a model call. It asks the model provider whether the installation's key is
  accepted, using the provider's free model list, and says "The provider key was refused" when the
  provider answers 401. A 403 is reported as a refused request that may be about the key's permission
  or about the server's country or region; a 404 or 405 is reported as "there is no model list at this
  address", so the key cannot be tested there. Neither is called a refused key. A plain `lares doctor`
  makes no outside call and shows "Model provider key" as not tested. `--test-model` with `--gateway`,
  `--alias` and `--key-file` still sends one paid completion to a gateway you name.
- **`sudo lares provider-key set --key-file <path>` replaces the installation's model provider key.**
  It writes the key file in one step, as the installer writes it (owned by root, readable only by root
  and the file's group), and never prints the key; `--key-file -` reads a key piped to it. It then restarts only the
  model gateway, the one service that reads the key; a model call under way at that moment is cut off.
  When the gateway is running again it says so and suggests `sudo lares doctor --test-model`. If the
  gateway cannot be restarted, does not stay up, or the restart or the check after it takes too long,
  it says the new key is saved and gives the command to run next. On a server with no provider key
  file to replace it changes nothing and says so.

## Smaller changes (included from rc.15.test.2)

- **Connect Google when the second Google client is missing.** When the server has no Google client
  for mailbox and calendar access (only the one used to sign in to the console), pressing Connect
  Google returns to Your accounts with a box headed "Google could not be connected yet." It says
  a second Google client is needed, separate from the sign-in one, and links to the install guide
  section that sets it up. The console writes one line about it to its log, with no client ids or
  secrets. The install guide says what happens without the second client.
- **The chief of staff's description of itself** says that adding a deadline and restarting a
  stopped deadline's reminders ask for no approval.

## Installing and updating

- **A fresh install followed by a restore is one way in.** Install with
  `bash get-lares.sh --release 2026-11-17-rc.15.test.3 --yes`, then, as root,
  `lares restore --snapshot latest --dry-run` and `lares restore --snapshot latest` (see section 9 of
  the install guide for the steps around them). The restore takes a backup made on rc.14 or an rc.14
  test release.
- **Restore right after the install, before `sudo lares budget setup`.** A restore onto a server whose
  spending limits are already set up finishes with spending closed and says to keep the agents
  stopped; this release has no command that reopens it.
- **The in-place update from rc.15.test.1 to rc.15.test.2 has been run on a real test server.**
  The update finished, and `lares doctor` afterwards reported
  that the server runs exactly that release, with all checks passing. Before the update would run,
  backups had to be switched on and verified: the update always takes a backup first, and it refused
  while no backup had been verified.
- **The in-place update from rc.15.test.2 to this release has not been run on a real server.**
  `sudo lares update --release 2026-11-17-rc.15.test.3` is written and covered by script and database
  tests, and the update script (`update.sh`) is unchanged since the rc.15.test.1 build, which is the
  script the test.1 to test.2 update ran. No database file changed since rc.15.test.1. The same update
  from rc.14 has not been run on real images either.
- **A server on rc.12 or earlier cannot update to this test release in place.** The update refuses it
  before changing anything. The message says that the Compose, credentials, or database do not match
  one installed Lares target; it does not say the server is too old. The reason is that such a server
  lacks the operator database password file (`/etc/lares/operator/database-password`), which the
  update checks before anything else. This follows from the code and has not been run against a real
  rc.12 server. Moving from rc.12 or earlier to this release has not been tested.
- **Before changing anything, the update also refuses** a server where any agent store is neither
  exactly as rc.14 left it nor already at this release (it names the store and says how many schema
  steps it found), a store that has no workflow tables at all, and a database that is not set to UTC.
- **This update ends open web-chat conversations**, and so does every later save of a change to a
  running agent; web chat says so.
- **The update stops the Keeper and the agents** while it upgrades the agents' stores. If it fails after
  it has begun upgrading the stores, they stay stopped until the same update is run again; a failure
  before that starts them again on the previous release.
- **A backup made on rc.14 restores onto this release**; a backup in any other layout is refused with
  nothing changed.
- **Going back** to the previous software needs a restore onto a clean server, not the rollback command.

## Known gaps in this release

- **A dead provider key is not named in web chat.** If the model provider refuses the installation's
  key, web chat does not say so: the conversation stops with a general sentence, such as "This
  conversation has ended. Start a new one.", that does not say the key is the problem.
  `sudo lares doctor --test-model` tells you when the key was refused, and
  `sudo lares provider-key set` replaces it.
- **Setting reminders from web chat is not in this release.** Setting or cancelling a reminder, closing
  a deadline and adding a year of statutory deadlines are not offered in web chat. Reminders can still
  be set on Slack and Telegram.
- **A creative agent is not told today's date**, in web chat or on Slack and Telegram. Only the chief of
  staff is.
- **In a Slack channel, a follow-up in a thread without a mention was not answered.** On a test server running
  rc.15.test.2, a follow-up in the thread without a mention got no answer until the app was mentioned
  again.
- **Only Anthropic models are on the tested path in this release.** Setting an OpenAI or other model by
  hand is not on it, and chat will be refused.
- **Selective import from an older installation can only preview.**
- **The e-mail door is gone:** an agent definition that still has one is refused and the agent keeps its
  last valid definition.

## Tested, and not tested

Manual runs, all finished with success (listed under "How it was published"). What they ran:
- The keeper workflow's run (44081849568) passed its jobs: select, keeper, runtime (chief-of-staff),
  runtime (creative) and real-install. The `real-install` job is the real-install check, which sends
  Slack and Telegram messages and test briefs through the Keeper, with stand-ins for Slack, Telegram,
  the model provider and sign-in.
  The same job also ran the channel-mention stage and the key-replacement stage (it printed
  `PASS: provider-key-set-replaces-the-key-and-the-gateway-uses-it`), with stand-ins for Slack and the
  model provider.
- The console run (44081886616) passed its typecheck and build-and-push jobs.
- The sync-jobs run (44081923293) passed its build-and-push job.
- A security scan ran on each final image before it was published (see below).

**Verified on a test server (16 November 2026, running rc.15.test.2):**
- The in-place update from rc.15.test.1 to rc.15.test.2, described under "Installing and updating".
- A first real Slack channel mention. With a Slack app made from the console's manifest, mentioned in a
  channel, the agent answered in the thread, said that it is a shared channel where
  only some tools are available, and answered a question about the time correctly. A follow-up in the
  thread without a mention got no answer until the app was mentioned again.

**Not verified live:**
- Mentions: on real Slack, only the mention described above is recorded. No other real mention is
  recorded, including one in a private channel, one to a creative agent, or one to a Slack app made
  before rc.15.test.2 and brought up to date by hand with the four steps above. How the agent follows the
  channel instructions in cases other than the one above is not tested with a real model.
- The in-place update from rc.15.test.2 to this release.
- Listing and searching notes: paging and search are tested by automated tests, including a Keeper test with the
  real database and real files that lists 2,000 notes page by page, lists one folder, finds a note by
  search and reads it, each request inside the 2 second limit (about 0.4 to 0.5 seconds per request on
  the author's Mac). Another Keeper test shows a symlinked note, a hard-linked note or a nested
  repository in the listed folder still refuses the page. Nothing was tried in a running console with a
  real model, and nothing with a real area of more than 2,000 notes on a server.
- The provider-key check: Anthropic and OpenAI both answered a fake key with 401 in a hand run on
  16 November 2026. The answer to a real, accepted key was not seen.
- The refused call given back at once: on 16 November 2026 Anthropic, OpenAI and an OpenAI-compatible
  provider each answered a fake key with 401. No provider was seen answering 403.
- Web chat deadlines and the message typed while a card waits were tested in automated tests only
  (the owner's dismissal of a deadline with a real database), not in a running console with a real
  model.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, run by CI on 2026-11-17 against each final linux/amd64 image
immediately before it was published. The published digests were not scanned a second time. High and
critical findings:

| Image | Critical | High |
|---|---|---|
| console | 1 | 37 |
| keeper | 3 | 138 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 37 |
| chief-of-staff runtime | 1 | 112 |
| creative runtime | 1 | 112 |
| sync jobs | 1 | 112 |

These are the counts printed by the scan step of each run ("Final image vulnerability occurrences").
Compared with the rc.15.test.2 notes, every Critical count is the same and every High count is one lower, except the egress proxy (no findings in either). The findings were not compared one by one.

## How it was published

The record is `releases/2026-11-17-rc.15.test.3.json`, written on 17 November 2026. One manual run of
each image workflow on the same commit, `f08f84a6f7b3ae46156597377caf87e5825a580b`, each started with
publishing on, all three finished with success:
- keeper and neutral runtime images (keeper, egress proxy, firewall helper, chief-of-staff runtime and
  creative runtime): run 44081849568;
- console: run 44081886616;
- sync jobs: run 44081923293.

Each of the seven built digests in the record was read from the registry, without signing in, by the
image's tag for this commit, and compared with the digest printed in the run. All seven matched.
The database, gateway and proxy images are copied unchanged from the rc.15.test.2 record.
