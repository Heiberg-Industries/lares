# Changelog

The history starts at the first public release, v0.1.0. Earlier work is not recorded here.

## Unreleased

- The Notion sync can now run on the server as an optional service. It keeps meeting attendees and People records in Notion up to date once an hour. It is off on every installation until the owner switches it on in the console (Settings, Notion, Notion sync), runs a preview that shows what it would add, update or leave alone (writing nothing), and accepts that preview. The acceptance belongs to the exact settings previewed, so changing the Meetings or People database means a new preview. The service restarts or stops with the shared Notion key, and a restore always leaves it off. Pages and transcripts between the Vault and Notion are not part of it yet.

- A chat no longer hangs on "is running…" when an action is refused while its approval card is being prepared, for example a private note whose title is already in use. The agent now gets the reason and can say it, and nothing is changed.

- `lares update` now moves running agents onto the new release: each one restarts once, at the end of the update. An agent with changes waiting to be applied is left alone and named, and so is one the keeper cannot read. `sudo lares agent refresh` does the same step on its own. The update also downloads the agents' and the keeper's helper images before it switches, so the first save or start afterwards no longer times out in the console while the action goes through. The keeper's log now says which step held an agent back ("is held: …").

- `lares update` now sees a backup that `lares backups` has verified, so it no longer asks for `--even-though-the-backup-is-unproven` on an installed server. On a server where backups were never set up, the update now stops with "backups are not set up on this server yet … run sudo lares backups" instead of a shell error. `lares update --release-file <path>` updates from a release file already on the server.

- A chief of staff can now save a new private Vault note from Console chat. Each note needs its own approval card, and Keeper writes it into the member's own private area only once that card is approved, and only if the note has not changed since. Before this, an agent created in the Console had no way to save a note and said its Vault access was read-only. Moving or deleting notes, and memory, are still not available in Console chat.

- The money ledger no longer stops after about 340 model calls. When a ledger book fills up, Keeper seals it and starts the next one, and nothing is ever deleted. Each step now compares what can still change money, and the whole ledger is compared at every Keeper start and once a night at 03:00 UTC. `lares doctor` shows the ledger's state.

- Two people or agents calling a model at the same moment no longer lose out to each other. Spending steps now wait briefly in line, for two seconds at most, instead of being refused. Before this, an overlap could stop a reply or end a conversation with a message about the gateway setup. Sustained overload is still refused.
- A database stall, a killed keeper or a power cut no longer freezes the spending ledger for good. The keeper proves from the database whether the interrupted step saved, records that and carries on, and it can start again after a crash with the key store in use. If the records really disagree it still freezes. `sudo lares budget recover` proves the ledger and lifts a freeze, changing no money record; `--check` only reports. It cannot yet recover after restoring a backup older than the latest spending.
- Approval cards other than personal mail, such as creating a track, can now be answered in private chat. Who may answer has not changed: only the member who started the conversation, for that exact card, and edit rights are checked again when the change is written. A change to a track in a Twenty CRM can be approved only by the installation's owner. A question from an agent now shows as its text instead of "is running…".

- Budgets now carry on into a new month. At 00:00 UTC on the first, Keeper opens the month by itself for the installation and everyone on it: the limit on record, counted from zero. Unused money does not carry over, and calls whose cost is still unknown keep counting until resolved. Before this, every agent stopped spending at the first month change and nothing could reopen it.

- Budgets now survive a server reboot. A database restart no longer freezes the spending ledger when it is the same database, the ledger has nothing unfinished and every money row matches; an older backup is still refused. A ledger that really is frozen now stops spending only, so the console and restore keep working, and the log says why. A crash or power cut during spending can still freeze the ledger, and there is no way yet to undo a freeze.

- Every console page now sits on one grid: the same left edge and title position everywhere, wide for tables and lists, narrow for forms, settings and chat. The agent page's Agent access section no longer runs wider than the rest of the page, and now lives on that page's Access tab. Dropdowns, text boxes, checkboxes and field groups are now design-system parts, and every page uses them. A test fails when a page leaves the grid or adds a hand-built control.

- Restore cleanup now keeps its evidence when a temporary client identity or removal cannot be verified. In that case, stop and have an operator review the server before taking another recovery action.

- Delivery routing, engine side. An agent definition may now carry an optional `delivery` map: for each kind of message the agent starts on its own (briefs, nudges, deadlines, proposals, email triage, meeting follow-ups, outreach replies, CRM routing, digest, reminders) an ordered list of doors (`web`, `slack`, `telegram`). The first connected door is used; if none is, the message goes to web chat and the activity ledger records why. An agent without a `delivery` map keeps its current doors exactly. Web chat is a new inbox table (`services/box/sql/004_web_inbox.sql`, applied by `pnpm -C services/box migrate`).

- Delivery routing, console side. The agent page has a "Where messages go" grid (rows are kinds of message, columns are web chat, Slack and Telegram; number the doors in the order to try them), pre-filled with today's behaviour. Web chat shows messages the agent left for you at the top, with a dot beside "Chat" in the navigation and a "Reply" that opens a chat starting from the message. A message that went to a different door than asked says so on the Activity ledger and the grid. Saving a brief hour, a door's quiet hours, or a routing is refused, in plain words, when the brief would fall inside the quiet hours of the door it goes to. A new chief of staff starts with every kind going to its first chat door, then web chat.
- The meeting follow-up schedule no longer falls back to a built-in Notion database. Set `NOTION_MEETINGS_DATA_SOURCE_ID`; without it the schedule fails with a clear message.

- Simpler doors. Telegram: paste the bot token, press Connect, tap one link. Slack: open the manifest, paste the bot token and signing secret, press Connect, send one message. Telegram's `/start <code>` is accepted as the same claim as `claim <code>`.

- A designed console sign-in page (Continue with Google; other options shown as coming soon), and sign-out no longer signs the same account straight back in.

- Console wording: why there is an agent limit, what Instructions and Personality add to the built-in role, what Language does, a sentence for every schedule, and progress while an agent is created.

- A fresh installation can approve in web chat before any door is connected: approval falls back to the installation's administrator. A chat label shows the agent's display name instead of "AGENT".
