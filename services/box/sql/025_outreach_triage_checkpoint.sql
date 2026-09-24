-- ORB-93 — a durable checkpoint so a restart/DB hiccup between detecting a reply and
-- markReplied doesn't re-detect the SAME reply on the next 15-minute poll: markReplied only
-- ran after the full billed triage session resolved, so a crash in between meant the thread
-- stayed 'awaiting_reply' and the next tick started an entirely independent second triage —
-- duplicate sessions, duplicate approval cards, two 👍 = two replies sent. beginTriage sets
-- this BEFORE starting; a still-fresh checkpoint means "already in flight, skip re-detecting
-- this tick," while a stale one (past the retry window) means "that attempt likely crashed,
-- try again."
ALTER TABLE outreach_threads ADD COLUMN triage_started_at timestamptz;
