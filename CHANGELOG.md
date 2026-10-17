# Changelog

The history starts at the first public release, v0.1.0. Earlier work is not recorded here.

## Unreleased

- Delivery routing, engine side. An agent definition may now carry an optional `delivery` map: for each kind of message the agent starts on its own (briefs, nudges, deadlines, proposals, email triage, meeting follow-ups, outreach replies, CRM routing, digest, reminders) an ordered list of doors (`web`, `slack`, `telegram`). The first connected door is used; if none is, the message goes to web chat and the activity ledger records why. An agent without a `delivery` map keeps its current doors exactly. Web chat is a new inbox table (`services/box/sql/004_web_inbox.sql`, applied by `pnpm -C services/box migrate`).

- Delivery routing, console side. The agent page has a "Where messages go" grid (rows are kinds of message, columns are web chat, Slack and Telegram; number the doors in the order to try them), pre-filled with today's behaviour. Web chat shows messages the agent left for you at the top, with a dot beside "Chat" in the navigation and a "Reply" that opens a chat starting from the message. A message that went to a different door than asked says so on the Activity ledger and the grid. Saving a brief hour, a door's quiet hours, or a routing is refused, in plain words, when the brief would fall inside the quiet hours of the door it goes to. A new chief of staff starts with every kind going to its first chat door, then web chat.
- The meeting follow-up schedule no longer falls back to a built-in Notion database. Set `NOTION_MEETINGS_DATA_SOURCE_ID`; without it the schedule fails with a clear message.
