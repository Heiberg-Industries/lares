# rc.15.test.6 release notes

**This is a test release, not rc.15.** It is the sixth test release on the new version of the agent
framework (`eve` 1.0). Do not use it for an installation you depend on. Its record is
`releases/2026-11-19-rc.15.test.6.json`. The name deliberately differs from the usual date, `rc.` and
number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed in the record were built from commit `c6ad7406bf7caa6435f7b9df2e468e15445fbc7d`.

Since rc.15.test.5 (commit `1467b5c027ec80b992a696f40b2db7a0ef5e1427`) the code changed in one
behaviour, a merged pull request: an email draft now waits for Approve when the agent's mail setting is
to ask first (see "Email drafts wait for Approve" below). The other commit since test.5 recorded the
rc.15.test.5 release; it also moved the date the model price table was last checked, in
`services/box/ops/budget-commands.py`, to 18 November 2026.

What that change shows about the images (expected from the files it touches; the real answer is the
comparison of digests below):
- It changes files of the chief of staff and of the shared agent kit (the assistant's description of
  drafting and the assembled persona). No database file, Compose file, Caddy file or gateway file
  changed since rc.15.test.5.
- The database image, the gateway image (the upstream LiteLLM image, which this project does not build)
  and the proxy in front of the console (Caddy) are copied unchanged from the rc.15.test.5 record.
- A publishing run builds all seven images, so their digests may differ from rc.15.test.5's even
  where no input file changed.

What the digests show: all seven images built in the three publishing runs have a different digest from
the one in the rc.15.test.5 record, including the egress proxy, the firewall helper, the console and sync
jobs, whose input files this change did not touch. Nobody compared what is inside those images. The
database, gateway and Caddy digests are the same as in the rc.15.test.5 record.

The public documentation inside the agent images identifies itself as `candidate`, not as a numbered
release.

Model prices were last checked on 18 November 2026.

## Email drafts wait for Approve

- **What was wrong.** Asking the assistant to draft an email saved a Gmail draft at once, with no
  Approve card, even though the agent's mail setting said to ask first. Calendar writes in the same chat
  did show a card. The two draft tools carried their own fixed "act on its own" level, and that
  outranked the agent's definition.
- **What changed.** Drafting an email and changing a draft's recipients now start from the definition's
  mail level like every other write. With mail set to ask first, a card appears with the draft's to,
  subject and body, and nothing is saved to Gmail before Approve. This is in the shared approval layer,
  so Slack, Telegram and web chat behave the same.
- **The permissions board still wins.** An installation can set either action to act on its own there,
  and then no card is shown. An agent whose mail setting already lets it act on its own gets no card, as
  before.
- **A new test guards the rule.** It reads every tool in the chief of staff's catalogue folder and checks
  that each tool with an approval check asks when the definition says to ask first; a tool without one
  must be named on a short reviewed list, so a new write tool added without a gate fails the build.
  It fails on the old code for exactly the two draft tools.
- **Also updated:** the assistant's own description of drafting (and the assembled persona), and the
  door tool table, which now shows a card for drafts on Slack direct messages and Telegram.
- **No database change** came with this part.

## Private notes from Slack and Telegram (included from rc.15.test.5)

- **The agent can list, read and search your private notes from a private Slack message or a private
  Telegram chat.** Before, on those doors the agent read only its own
  folder, which holds none of your private notes. Now the Keeper opens a pass of at most five minutes for one chat turn, and the agent reads
  through it.
- **Who gets the pass.** Only the person who claimed that Slack or Telegram door, speaking in a private
  chat, in a conversation that was also started in a private chat. A channel, a group chat or a
  conversation that was started there never gets one, and no note tool is offered there. A door the
  code does not know is refused.
- **What the Keeper checks.** The agent names the door, the claim it speaks under, the turn and its
  definition, never a member. The Keeper finds the member itself and, on every read, checks the claim,
  the member's use of the agent, the definition and the member's access to the area again.
- **Whose notes.** The claimed person's own private notes. Being the installation's owner does not open
  anyone else's notes.
- **Not offered on these doors:** backlinks, filing and deleting notes. A call that arrives anyway gets
  one fixed sentence. Saving a note is a separate part (see "Saving a note from Slack or Telegram").
- **No database change** came with this part.
- A creative agent's files changed only in tests; the note changes are in the chief of staff.

## One place for the rules about cards (included from rc.15.test.5)

- **Slack, Telegram and web chat ask one shared card layer** whether a tap on a card counts. Each door
  only hands over the tap; the sentences a person reads are the same on every door.
- **Who may answer.** An approval is answered by the installation's owner. A question card (a card that
  asks something with buttons, not an approval) is answered by the person it was put to. A card the
  record does not know goes through only for the owner (web chat still refuses it for everyone).
- **A late or second tap on a settled card** is told "This request is no longer waiting, so this answer
  was not used." A new hunk in the project's patch to the agent framework also drops such an answer in
  the framework's own delivery step, so it starts no turn.
- **The card record grows (database file `038_approval_card_record.sql`).** `approval_asks`, the table
  that records every card an agent shows a person, now also holds the door the card was shown on, where
  it sits (the Slack channel and message, or the Telegram chat and message), the person it was put to,
  whether it was shown whole, and whether it is an approval or a question. The file only adds: it
  changes no existing row, and a row written before it keeps empty values in the four new nullable
  columns. It also allows "answered" as the outcome of a question. The words on a card are not stored.
- **Erasing a person** now also removes the card records put to them.
- **A card a door had to shorten offers no Approve.** The layer says where the whole of it can be read:
  today the console's Waiting on you page. Telegram already did this in rc.15.test.4.
- **One error text changed:** a refused Telegram tap now gets the layer's sentence ("You cannot answer
  this request. Nothing was done.") instead of the earlier Telegram-only sentence.

## Slack shows a whole approval card (included from rc.15.test.5)

- **Slack draws the whole card, so you can approve it there.** The approval card is the card's title and
  then the exact change, with every detail, spread over as many Slack sections as it needs. A long note,
  draft or calendar change can be read and approved without leaving Slack. In rc.15.test.4 a long input
  was cut at one Slack section (3,000 characters) and Approve stayed.
- **Only a card too big for one Slack message is cut.** That is more than 50 blocks of 3,000 characters.
  Such a card says how many characters are not shown, offers no Approve, and Deny stays. The framework
  rejects a card whose buttons differ from its own, so a second hunk in the project's patch to the
  framework leaves Approve off such a card.
- **Telegram keeps its own layout.** It reads the same title and the short form of the details.
- **Door names print as plain words.** The reminder card and the reminder list say "Slack" or "Telegram"
  instead of the stored ids. `remind_set` accepts "Slack" and "Telegram" as well as the lower-case ids,
  so a copied value works.

## Saving a note from Slack or Telegram (included from rc.15.test.5)

- **You can save a private note from a private Slack message or Telegram chat.** The agent shows one
  card; you approve it there; the note is saved. The card is prepared before it is shown. If your
  private notes cannot be reached, or saving is not possible from that chat, no card is shown and the
  agent says so, and that nothing was saved and nothing was asked for.
- **Who can approve it.** Only the person who claimed that chat, who must also be the owner, and only on
  the door the card was shown on. The Keeper names the member itself and checks the claim, the access
  grant and the card again when it writes.
- **A note is saved once, as a new note only.** An old, used or changed card, or a title that has been
  taken since, saves nothing, and every refusal after an approval says that nothing was saved.
  Moving and deleting notes stay unavailable on these doors.
- **An approval given in Slack or Telegram only runs when its card was shown in full there.** This is
  one rule for every action that needs approval, on every door. A card that was cut, a card with no
  record and a record that cannot be read all stop with one sentence: you approved it, but it could not
  be confirmed that the request was shown in full where you approved it, so nothing was done; ask again
  and approve the new request on the console's Waiting on you page. Approvals given on that page still
  run, and a call that raised no card is not affected.
- **What this means in practice.** A card cut by length on Slack, a card written before this update, or
  a card with no record is now refused after you approve it. A normal-length card on Slack or Telegram
  is recorded as shown in full and runs as before.
- **No database change in this part** beyond file 038 above.

## Console action list (tests only) (included from rc.15.test.5)

The console has a committed list, generated from its code, of every page, every server action and every
route handler, with who may see and use each one. A test fails when the list is out of date. Nothing in
a page, action, route or `lib/auth.ts` changed, so nothing a person sees or does is different. It
found two pages that are open to members, `/accounts` and `/agents/[name]/outside-tools`, where the
owner's rule says owner-only; they were not changed here; the pull request left the decision to the owner.

## The agent framework: eve 1.0.1 (included from rc.15.test.4)

- **Both agent roles, the agent kit and the console now run on `eve` 1.0.1**, the final release, instead
  of the release candidate 1.0.0-rc.10. The AI SDK moved with it (`ai` 7.0.172).
- **The project's three fixes to the framework still apply.** The patch that fixes attachment staging,
  typed approval answers and the Telegram approval card was unchanged in rc.15.test.4; this release adds
  two hunks to it (a late tap on a settled approval is dropped, and Approve is left off a Slack card too
  big for one message), described above.
- **No new built-in framework tool.** The framework's default tools are the same seven, and both roles
  still turn all of them off.
- **No database file changed for the framework.** The agents' workflow stores keep the same tables and
  the same version of the library that makes them.
- **A Slack approval card holds the call's input in the card itself.** For a tool Lares does not
  summarise (an outside tool among them), the card showed the whole call input under its title, in a code
  block, and kept it there after you answered. In rc.15.test.4 an input longer than one Slack section
  (3,000 characters) was cut; in this release the card is drawn whole instead (see "Slack shows a whole
  approval card"). For a tool Lares summarises, the card shows Lares's own summary, as before.
- **A Slack mention that starts a thread** no longer makes the agent read the thread first, so one Slack
  call fewer is made.

## One copy of the Slack door and the approval rules (included from rc.15.test.4)

- **Both roles share one copy** of the Slack door, the Slack approval card, the approval rules (who may
  approve, who may answer a card on Slack or Telegram) and the list of people an agent answers. Each role
  had its own copy before, and the copies had drifted. Where the two roles behaved differently, each
  keeps its own behaviour through a setting. Apart from the next two points, nothing an agent does changed.
- **Web chat names a member only through the console's admission.** The console names the signed-in
  member to the agent by the member's stable id, an admission code and its purpose. Both roles' web
  chat stopped reading the older `x-lares-member` address header, and the console's waiting page stopped
  sending it. When the waiting page reads or answers a card in a Slack or Telegram conversation, the
  owner's address now comes from the member record that the admission check has already verified. A
  request that carries only the address header now names nobody and approves nothing.
- **One error message changed:** when an approver is refused, the message now names the shared
  allow-list file (`packages/agent-kit/src/principals.ts`) instead of the role's own `lib/principals.ts`.

## Person voice profiles (included from rc.15.test.4)

- **Every member can have one writing profile.** Database file `037_person_voice_profiles.sql` adds a
  table with one profile per member, and empty columns on the two existing voice tables that say whose a
  mailbox's voice card and examples are and which connected account they came from. It also allows
  "interrupted" as the state of a voice learn. It only adds: no existing row is changed. The update
  applies it.
- **Nothing reads the new profiles yet.** The console's voice page is unchanged, and drafting works
  exactly as before.
- **`sudo lares voices map`** is a new owner command that links today's mailbox voices to members. By
  default it prints a report and changes nothing; `--help` shows its options. Only with `--apply` does
  it make the changes, all in one transaction, which it checks afterwards and undoes completely if
  anything does not match.
  - A mailbox is linked only when exactly one connected Google account has exactly that address, as
    Google confirmed it. The mailbox's member is that account's owner. No match, several matches, or a
    match only when upper and lower case are ignored leave the mailbox unlinked, and the report says
    why. `--map <mailbox>=<account id>` links an unlinked mailbox to an account you name.
  - The shared default voice card is copied into a profile for the installation's owner when there is
    exactly one active owner; otherwise `--default-owner <member id>` names the owner to give it to.
  - A voice learn still marked as running is marked interrupted and is not restarted. When the agent's
    voice-learning schedule checked in during the last five minutes, the report says so, because such a
    learn may really be running and then writes its own state again when it ends.
  - Running the command again links only what is not linked yet.
- **Erasing a person** now also removes their writing profile and the mailbox voice cards and examples
  linked to them, and the erase report counts each once.

## Listing and searching notes (included from rc.15.test.3)

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
  those out. For a person who may see every note, a search answers as before. (In this release, a
  chief of staff's private Slack and Telegram chats list, read and search through the Keeper instead;
  see "Private notes from Slack and Telegram".)
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
  `bash get-lares.sh --release 2026-11-19-rc.15.test.6 --yes`, then, as root,
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
- **The in-place update from rc.15.test.5 to this release has not been run on a real server.**
  `sudo lares update --release 2026-11-19-rc.15.test.6` is written and covered by script and database
  tests, and the update script (`update.sh`) is unchanged since the rc.15.test.1 build, which is the
  script the test.1 to test.2 update ran. The same update from rc.14 has not been run on real images
  either.
- **An update from rc.15.test.5 applies no new database file.** An update from rc.15.test.4 or earlier
  applies `038_approval_card_record.sql`, which adds columns, a check on the kind of card, a wider list
  of outcomes and an index, and changes no existing row; a second run changes nothing. An update from
  rc.15.test.3 or earlier also applies `037_person_voice_profiles.sql`. The image check in the keeper run (its chief-of-staff runtime job)
  applies every database file in order to an empty database, then applies 038 a second time and checks
  that a question card written before the second run survives it and that an unknown card kind is
  refused.
- **Approval cards that are open when you update** have no mark that they were shown in full, so
  approving one on Slack or Telegram after the update is expected to be refused with the sentence
  described above ("nothing was done; ask again"). This follows from the code and from the migration
  leaving old rows empty; it has not been tried on a real server.
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

- **Notes from Slack and Telegram are for one person in a private chat.** In a channel or group chat
  no note tool is offered. Backlinks, filing and deleting notes are not offered on these doors, and a
  note can only be saved as a new one. Moving and deleting notes stay unavailable on these doors.
- **A card too long for its door cannot be approved there.** On Telegram, and on Slack when a card
  needs more than 50 blocks, the card offers only Deny and points to the console's Waiting on you page.
- **Two console pages are open to every signed-in member** where the owner's rule says owner-only,
  `/accounts` and `/agents/[name]/outside-tools`. The console action list shows both and they were not
  changed; the owner has to decide each one.
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
- **No agent uses the new writing profiles yet**, and the console has no page for them.
- **Only Anthropic models are on the tested path in this release.** Setting an OpenAI or other model by
  hand is not on it, and chat will be refused.
- **Selective import from an older installation can only preview.** Its preview does not include the
  voice tables.
- **The e-mail door is gone:** an agent definition that still has one is refused and the agent keeps its
  last valid definition.

## Tested, and not tested

Manual runs, all finished with success (listed under "How it was published"). What they ran:
- The keeper workflow's run (44616065793) passed its jobs: select, keeper, runtime (chief-of-staff),
  runtime (creative) and real-install. The `real-install` job is the real-install check, which sends
  Slack and Telegram messages and test briefs through the Keeper, with stand-ins for Slack, Telegram,
  the model provider and sign-in. No file of that check changed in this release, so it does not ask for
  a draft or press a card. The runtime (chief-of-staff) job applied every database file to an empty
  database.
- The console run (44616109235) passed its typecheck and build-push jobs.
- The sync-jobs run (44616155418) passed its build-push job.
- A security scan ran on each final image before it was published (see below).
- Automated tests in the pull request cover the new rule that every tool with an approval check asks
  when the definition says to ask first, the two draft tools asking, the door tool table and the
  assembled persona. Their results are those of the pull request's own checks; nothing in this list was
  run on Slack, Telegram or a server.

**Verified on a test server (16 November 2026, running rc.15.test.2):**
- The in-place update from rc.15.test.1 to rc.15.test.2, described under "Installing and updating".
- A first real Slack channel mention. With a Slack app made from the console's manifest, mentioned in a
  channel, the agent answered in the thread, said that it is a shared channel where
  only some tools are available, and answered a question about the time correctly. A follow-up in the
  thread without a mention got no answer until the app was mentioned again.

Nothing in this release has been verified on a test server yet.

**Not verified live:**
- Asking for an email draft on real Slack and on real Telegram: the card showing the draft's to,
  subject and body, Gmail staying empty until Approve, and the draft appearing in Gmail after Approve.
  The same for changing a draft's recipients.
- An update with a conversation open, including a call that was approved but has not run yet, and with an
  approval card open at the moment of the update.
- The in-place update from rc.15.test.5 to this release.
- Saving a note from a Slack direct message and from a Telegram private chat: the card, Approve, the
  saved note, and the sentences when it is refused.
- Listing, reading and searching private notes from Slack and Telegram on a real server.
- A long card shown whole on real Slack, across several blocks, with Approve; and the larger card that is
  cut and has no Approve.
- A normal approval (a reminder, a calendar change) running on real Slack and Telegram after the rule
  that its card must have been shown in full.
- The console's Waiting on you page answering a Slack card, and a Telegram card, raised on a chat door.
- A Telegram tap's responder for a note card: who the framework names for a tap that carries no identity
  of its own.
- The creative role's Slack door, which draws the whole card from the shared copy. The real-install
  check does not run it.
- `sudo lares voices map` on a real installation's rows. It was run only on test data in automated tests.
- Carrying the voice tables to another installation: selective import does not include them.
- Mentions: on real Slack, only the mention described under "Mentions in a Slack channel" is recorded.
  No other real mention is recorded, including one in a private channel, one to a creative agent, or one
  to a Slack app made before rc.15.test.2 and brought up to date by hand.
- Listing and searching notes in web chat on a real area of more than 2,000 notes, and with a real model.
- The provider-key check and the refused call given back at once: only fake keys were tried, on
  16 November 2026, and each provider answered 401.
- Web chat deadlines and the message typed while a card waits were tested in automated tests only.

## Security scan

Scanner: Trivy 0.75.0, no ignore list, run by CI on 2026-11-19 against each final linux/amd64 image
immediately before it was published. The published digests were not scanned a second time. High and
critical findings:

| Image | Critical | High |
|---|---|---|
| console | 1 | 37 |
| keeper | 3 | 136 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 37 |
| chief-of-staff runtime | 1 | 112 |
| creative runtime | 1 | 112 |
| sync jobs | 1 | 112 |

These are the counts printed by the scan step of each run ("Final image vulnerability occurrences").
Compared with the rc.15.test.5 notes, every count is the same except four High counts, which are lower:
the Keeper (136, was 139), the chief-of-staff runtime (112, was 113), the creative runtime (112, was 113)
and sync jobs (112, was 113). The findings were not compared one by one.

## How it was published

The record is `releases/2026-11-19-rc.15.test.6.json`, written on 19 November 2026. One manual run of
each image workflow on the same commit, `c6ad7406bf7caa6435f7b9df2e468e15445fbc7d`, each started with
publishing on, all three finished with success:
- keeper and neutral runtime images (keeper, egress proxy, firewall helper, chief-of-staff runtime and
  creative runtime): run 44616065793;
- console: run 44616109235;
- sync jobs: run 44616155418.

Each of the seven built digests in the record was read from the registry, without signing in, by the
image's tag for this commit, and compared with the digest printed in the run. All seven matched.
The database, gateway and proxy images are copied unchanged from the rc.15.test.5 record.
