# rc.15.test.2 release notes

**This is a test release, not rc.15.** It is the second test release on the new version of the agent
framework (`eve` 1.0, release candidate 10). Do not use it for an installation you depend on. Its
record is `releases/2026-11-16-rc.15.test.2.json`. The name deliberately differs from the usual date, `rc.`
and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed in the record were built from commit `88e9d9a6860868e7ce92c54dfd2afd1063d2e6a6`.

What the changes since rc.15.test.1 (commit `fd63e523`) show about the images:
- The database image is unchanged: no database file changed.
- The gateway image is the upstream LiteLLM image, which this project does not build; in
  rc.15.test.1 it was copied unchanged from rc.14. The program that runs inside the gateway did
  change (see "A refused model call gives its room back at once" below), but that program is not
  carried in the gateway image: the installer writes it onto the server from the engine. The gateway
  image in the record is copied unchanged from rc.15.test.1.
- The console, the Keeper and both agent images contain changed code.
- The database, gateway and proxy in front of the console (Caddy) images are copied unchanged from the
  rc.15.test.1 record. All seven images built for this release have a different digest from the one
  in the rc.15.test.1 record, the egress proxy, the firewall helper and sync jobs included. Nobody
  compared what is inside those three images to say what differs.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

Model prices were last checked on 3 November 2026.

## Mentions in a Slack channel

You can now mention an agent in a Slack channel it was invited to. This replaces the rc.15.test.1
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
- **A Slack app made from the console** now asks for the bot permission `app_mentions:read` and the bot
  event `app_mention`, for both roles, and for nothing that lets it read other messages in a channel.
  The creative agent's app still does not ask for `im:write`. The console's Slack setup now says how to
  use the agent in a channel.

### A Slack app made earlier needs two additions, a reinstall and an invitation

A Slack app made before this release does not get the new permission and event by itself. In the app's
settings on Slack:
1. Add the bot permission `app_mentions:read` under OAuth & Permissions.
2. Add the bot event `app_mention` under Event Subscriptions.
3. Install the app to your workspace again.
4. Invite the app to the channel where you want to mention it.

The install guide gives the same steps. Without them, a mention in a channel is not expected to reach
the agent.

## Web chat

- **A chief of staff's web chat knows today's date.** A web chat conversation with a chief of staff is
  now told today's date, as Slack and Telegram conversations already were, so "Friday" is worked out
  from today's date instead of guessed. Web chat still gets none of the owner's remembered facts.
- **Deadlines and reminders in web chat, for the agent's owner only.** In a chief of staff's web chat
  the agent's owner can now list deadlines, add a deadline, restart a stopped deadline's reminders,
  dismiss a deadline (after approving a card) and list reminders. Before, web chat had no deadline or
  reminder tools. Someone who is not the agent's owner gets none of these in web chat. If a request to
  add a deadline or restart its reminders cannot be confirmed as coming from the agent's owner, the
  agent is told so and nothing changes. A shared Slack channel keeps only the two read-only lists.
- **A message typed while an approval card waits is answered.** The card nobody answered is withdrawn,
  as before, and a card you already approved still runs, as before. The agent now also reads the new
  message and answers it, however long the card had been waiting. Before, such a message usually got a
  red line and no answer. If the agent still cannot finish its reply, the red line now says what was and
  was not done: that your new message cancelled what was waiting for your answer, whether your answer to
  another card was applied, and that you should send the message again.
- **Clearer wording on an answered card.** When one step shows two cards and you have answered one, the
  answered card now says what happens next instead of "Waiting for the agent.": an approved card says it
  runs once the other card is answered or you send a new message, and a denied card says the agent goes
  on at that point. In a conversation that has ended, or where the page cannot answer or send, an
  answered card that is still open says only "You have answered this.", and the line below the
  conversation says why.
- **The note tool no longer speaks of a thumbs-up.** The agent's description of its note tool, and web
  chat's own instructions, no longer say that a note needs your thumbs-up or waits in a queue. They now
  say that once you approve the card, the note is saved, with no further step. New notes still land in
  the area's `_inbox` folder.

## Model provider and keys

- **A refused model call gives its room back at once.** When the model provider refuses a call with
  HTTP 401 or 403 (the answers for a key or a request it does not accept), the call is now counted as
  costing nothing straight away, so the room it had set aside in the monthly spending limit is given back
  at once instead of being held until the month ends. The Keeper writes one line about it to its log,
  naming only the status. A 429, any 5xx, a timeout, a dropped connection, a cancelled call and the
  gateway's own refusals keep the room set aside, as before. If the gateway's report of the refusal is
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

## Smaller changes

- **Connect Google when the second Google client is missing.** When the server has no Google client
  for mailbox and calendar access (only the one used to sign in to the console), pressing Connect
  Google now returns to Your accounts with a box headed "Google could not be connected yet." It says
  a second Google client is needed, separate from the sign-in one, and links to the install guide
  section that sets it up. Before, the page said only "The account could not be connected. Try again."
  The console writes one line about it to its log, with no client ids or secrets. The install guide
  now says what happens without the second client.
- **The chief of staff's description of itself** now says that adding a deadline and restarting a
  stopped deadline's reminders ask for no approval.

## Installing and updating

- **Use a fresh install followed by a restore.** Install with
  `bash get-lares.sh --release 2026-11-16-rc.15.test.2 --yes`, then, as root,
  `lares restore --snapshot latest --dry-run` and `lares restore --snapshot latest` (see section 9 of
  the install guide for the steps around them). The restore takes a backup made on rc.14 or an rc.14
  test release.
- **Restore right after the install, before `sudo lares budget setup`.** A restore onto a server whose
  spending limits are already set up finishes with spending closed and says to keep the agents
  stopped; this release has no command that reopens it.
- **An in-place update has not been run on a real server.** `sudo lares update --release
  2026-11-16-rc.15.test.2` from rc.14 and from rc.15.test.1 is written and covered by script and
  database tests, but neither has been run on real images. The update script (`update.sh`) is unchanged
  since the rc.15.test.1 build, and no database file changed since rc.15.test.1.
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
- **Only Anthropic models are on the tested path in this release.** Setting an OpenAI or other model by
  hand is not on it, and chat will be refused.
- **Selective import from an older installation can only preview.**
- **The e-mail door is gone:** an agent definition that still has one is refused and the agent keeps its
  last valid definition.

## Tested, and not tested

Three manual runs, all finished with success (listed under "How it was published"). What they ran:
- The keeper workflow's run (43906464350) passed its jobs: select, keeper, runtime (chief-of-staff),
  runtime (creative) and real-install. The `real-install` job is the real-install check, which sends
  Slack and Telegram messages and test briefs through the Keeper, with stand-ins for Slack, Telegram,
  the model provider and sign-in.
  The same job also ran the channel-mention stage and the key-replacement stage (it printed
  `PASS: provider-key-set-replaces-the-key-and-the-gateway-uses-it`), with stand-ins for Slack and the
  model provider.
- The console run (43906523422) passed its typecheck and build-and-push jobs.
- The sync-jobs run (43906572925) passed its build-and-push job.
- A security scan ran on each final image before it was published (see below).
- What the real-install job covers for the changes in this release is described under "Not verified
  live" below.

**Not verified live:**
- Mentions: the real-install image check mentions a chief of staff in a Slack channel, with stand-ins
  for Slack and the model provider. The creative role's mention is covered by unit tests only. The
  Slack app the console now makes has not been installed in a real Slack workspace, no mention has been
  delivered by real Slack to an installation, and whether the agent follows the channel instructions
  with a real model is not tested. Nothing was tried in a private channel.
  A real mention on a test server is planned after this release is installed there.
- The provider-key check: Anthropic and OpenAI both answered a fake key with 401 in a hand run on
  16 November 2026. The answer to a real, accepted key was not seen.
- The refused call given back at once: on 16 November 2026 Anthropic, OpenAI and an OpenAI-compatible
  provider each answered a fake key with 401. No provider was seen answering 403.
- Web chat deadlines and the message typed while a card waits were tested in automated tests only
  (the owner's dismissal of a deadline with a real database), not in a running console with a real
  model.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, run by CI on 2026-11-16 against each final linux/amd64 image
immediately before it was published. The published digests were not scanned a second time. High and
critical findings:

| Image | Critical | High |
|---|---|---|
| console | 1 | 38 |
| keeper | 3 | 139 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 38 |
| chief-of-staff runtime | 1 | 113 |
| creative runtime | 1 | 113 |
| sync jobs | 1 | 113 |

These counts are the same as in the rc.15.test.1 notes, image by image. The findings were not compared
one by one.

## How it was published

The record is `releases/2026-11-16-rc.15.test.2.json`, written on 16 November 2026. One manual run of
each image workflow on the same commit, `88e9d9a6860868e7ce92c54dfd2afd1063d2e6a6`, each started with
publishing on, all three finished with success:
- keeper and neutral runtime images (keeper, egress proxy, firewall helper, chief-of-staff runtime and
  creative runtime): run 43906464350;
- console: run 43906523422;
- sync jobs: run 43906572925.

Each of the seven built digests in the record was read from the registry, without signing in, by the
image's tag for this commit, and compared with the digest printed in the run. They matched. The
database, gateway and proxy images are copied unchanged from the rc.15.test.1 record.
