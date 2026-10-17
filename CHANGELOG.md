# Changelog

The history starts at the first public release, v0.1.0. Earlier work is not recorded here.

## Unreleased

- Delivery routing, engine side. An agent definition may now carry an optional `delivery` map: for each kind of message the agent starts on its own (briefs, nudges, deadlines, proposals, email triage, meeting follow-ups, outreach replies, CRM routing, digest, reminders) an ordered list of doors (`web`, `slack`, `telegram`). The first connected door is used; if none is, the message goes to web chat and the activity ledger records why. An agent without a `delivery` map keeps its current doors exactly. Web chat is a new inbox table (`services/box/sql/004_web_inbox.sql`, applied by `pnpm -C services/box migrate`).

- The meeting follow-up schedule no longer falls back to a built-in Notion database. Set `NOTION_MEETINGS_DATA_SOURCE_ID`; without it the schedule fails with a clear message.
