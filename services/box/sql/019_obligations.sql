-- ORB-45 — the obligation radar's read state.
--
-- WHAT IS DELIBERATELY ABSENT: message bodies, snippets, and subject text. This table holds
-- POINTERS — a thread id, timestamps, who spoke last, a dismissal — and nothing a person
-- wrote. Content is read in flight to compose one reason line and then dropped.
--
-- That is not squeamishness. The fleet already carries 31k imported private messages and a
-- standing exposure note about them; a second store of correspondence, accumulating quietly
-- and forever, is the thing that turns a useful radar into a liability. `services/network`
-- made the same call and calls its version a content-stripped replica.
--
-- The columns that DO exist each answer a question the rule asks every tick:
--   last_message_at + last_speaker_is_them  → is the ball his, and for how long
--   their_unanswered_count                  → is this a re-ping (>= 2)
--   dismissed_at                            → he said "handled"; never resurface it
--   reping_announced_at + _count            → this bump already interrupted him once
--
-- reping_announced_at is what stops one bumped thread nudging him every tick until he
-- replies. Dedupe lives in the DATABASE and not in process memory on purpose: an in-memory
-- set re-announces everything on each deploy, which is the fastest way to teach him to
-- ignore the messages (the same lesson notion_sync_proposals.announced_at records).
--
-- reping_announced_count is what makes "this BUMP" mean this bump rather than this THREAD.
-- It records their_unanswered_count as it stood when the thread last nudged him. A thread
-- bumped a second and a third time has a higher count each time, and a higher count earns
-- one more nudge (still under the daily cap); an unchanged count is the same bump and stays
-- quiet. Without it the dedupe means "this thread, ever" — and the thread someone keeps
-- bumping, which is the case the whole interrupt lane exists for, would go permanently
-- silent after its first nudge. NULL means announced before this column existed: read as 0,
-- so the next real bump is allowed through once. One extra nudge, never a missed one.
--
-- night_before_delivered_day is what makes the morning brief's suppression CONDITIONAL. An
-- obligation owed to someone he is meeting tomorrow is reported by the 20:00 pass and left off
-- the 08:00 brief (spec §5 — each item belongs to exactly one surface by rule). Suppressing it
-- unconditionally assumes that pass ran: if the agent was down at 20:00, the calendar read
-- timed out, or the meeting was booked at 21:00, the item appeared on NEITHER surface and
-- something he owes went unmentioned, silently. So the 20:00 lane records, per thread, the
-- Oslo calendar day its DELIVERED message covered — tomorrow's date, written only after
-- scheduledTurnDelivered() says a message actually arrived, and only for the threads that were
-- in it (an "unavailable" owed block told him nothing and records nothing). The brief suppresses
-- exactly the threads carrying today's date and reports everything else. A DAY, not a
-- timestamp, because the 20:00 write and the 08:00 read sit on opposite sides of midnight:
-- storing the day the message was ABOUT makes the check an exact string equality against
-- osloDayOf(now) instead of timestamp arithmetic across an Oslo day boundary. It is also
-- self-expiring — a mark for 2026-08-12 can never suppress anything on any other morning.
--
-- principal exists for a different reason: One Brain W5's schema guard (tests/schema-
-- principal.test.ts) requires every table to know which human it belongs to. This one
-- unambiguously does — it is his inbox's obligations — so it gets the column now rather
-- than joining the RUNG_2 backlog. Single-operator today, so every row reads 'bendik';
-- write it with the canonical user id, never a raw channel address.
CREATE TABLE IF NOT EXISTS obligation_threads (
  thread_id               TEXT PRIMARY KEY,
  principal               TEXT NOT NULL,
  source                  TEXT NOT NULL DEFAULT 'gmail',
  counterparty_address    TEXT NOT NULL,
  last_message_at         TIMESTAMPTZ NOT NULL,
  last_speaker_is_them    BOOLEAN NOT NULL,
  their_unanswered_count  INTEGER NOT NULL DEFAULT 0,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at            TIMESTAMPTZ,
  reping_announced_at     TIMESTAMPTZ,
  reping_announced_count  INTEGER,
  night_before_delivered_day TEXT
);

CREATE INDEX IF NOT EXISTS obligation_threads_open_idx
  ON obligation_threads (last_message_at DESC)
  WHERE dismissed_at IS NULL;
