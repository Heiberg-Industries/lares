# Changelog

The history starts at the first public release, v0.1.0. Earlier work is not recorded here.

## Unreleased

- Two people or agents calling a model at the same moment no longer lose out to each other. Spending steps now wait briefly in line, for two seconds at most, instead of being refused. Before this, an overlap could stop a reply or end a conversation with a message about the gateway setup. Sustained overload is still refused.

- Budgets now carry on into a new month. At 00:00 UTC on the first, Keeper opens the month by itself for the installation and everyone on it: the limit on record, counted from zero. Unused money does not carry over, and calls whose cost is still unknown keep counting until resolved. Before this, every agent stopped spending at the first month change and nothing could reopen it.

- Every console page now sits on one grid: the same left edge and title position everywhere, wide for tables and lists, narrow for forms, settings and chat. The agent page's Agent access section no longer runs wider than the rest of the page, and now lives on that page's Access tab. Dropdowns, text boxes, checkboxes and field groups are now design-system parts, and every page uses them. A test fails when a page leaves the grid or adds a hand-built control.

- Restore cleanup now keeps its evidence when a temporary client identity or removal cannot be verified. In that case, stop and have an operator review the server before taking another recovery action.

- Delivery routing, engine side. An agent definition may now carry an optional `delivery` map: for each kind of message the agent starts on its own (briefs, nudges, deadlines, proposals, email triage, meeting follow-ups, outreach replies, CRM routing, digest, reminders) an ordered list of doors (`web`, `slack`, `telegram`). The first connected door is used; if none is, the message goes to web chat and the activity ledger records why. An agent without a `delivery` map keeps its current doors exactly. Web chat is a new inbox table (`services/box/sql/004_web_inbox.sql`, applied by `pnpm -C services/box migrate`).

- Delivery routing, console side. The agent page has a "Where messages go" grid (rows are kinds of message, columns are web chat, Slack and Telegram; number the doors in the order to try them), pre-filled with today's behaviour. Web chat shows messages the agent left for you at the top, with a dot beside "Chat" in the navigation and a "Reply" that opens a chat starting from the message. A message that went to a different door than asked says so on the Activity ledger and the grid. Saving a brief hour, a door's quiet hours, or a routing is refused, in plain words, when the brief would fall inside the quiet hours of the door it goes to. A new chief of staff starts with every kind going to its first chat door, then web chat.
- The meeting follow-up schedule no longer falls back to a built-in Notion database. Set `NOTION_MEETINGS_DATA_SOURCE_ID`; without it the schedule fails with a clear message.

- Simpler doors. Telegram: paste the bot token, press Connect, tap one link. Slack: open the manifest, paste the bot token and signing secret, press Connect, send one message. Telegram's `/start <code>` is accepted as the same claim as `claim <code>`.

- A designed console sign-in page (Continue with Google; other options shown as coming soon), and sign-out no longer signs the same account straight back in.

- Console wording: why there is an agent limit, what Instructions and Personality add to the built-in role, what Language does, a sentence for every schedule, and progress while an agent is created.

- A fresh installation can approve in web chat before any door is connected: approval falls back to the installation's administrator. A chat label shows the agent's display name instead of "AGENT".
