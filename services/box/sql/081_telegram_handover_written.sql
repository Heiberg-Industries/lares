-- 081_telegram_handover_written.sql — which day's Telegram hand-over summary already exists.
--
-- WHY THIS COLUMN EXISTS. The day's continuity summary used to be produced only once a turn of
-- the NEXT day had completed (`services/chief-of-staff/lib/telegram-rotation.ts`), so the first
-- message of a new day was answered by a fresh conversation that had been handed nothing, and
-- the message after it was the first to carry yesterday. The summary is now written overnight,
-- for the day that just ended, before anybody writes in. That leaves two paths able to write the
-- same chat's summary — the overnight job, and the on-completion path it falls back to when the
-- job did not run (the box was down, or nothing has switched it on) — and exactly one summary
-- per chat and day is allowed. This column is what says a day has already been handed over:
-- the job skips a day it finds stamped (and never asks the model for it a second time), and the
-- on-completion path leaves a stamped day's summary untouched and only advances the anchor day.
--
-- ONE COLUMN, NULLABLE. Every row that exists today predates it, and a NULL reads as "no
-- hand-over has been written for this chat yet", which is exactly the state the on-completion
-- path has always assumed.
--
-- NO INDEX, NO NEW TABLE. Read and written by this table's primary key (`chat_id`) only, and
-- the summary itself keeps living where it always has — `pending_context`, the column the next
-- inbound message consumes.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

ALTER TABLE telegram_session_rotation
  ADD COLUMN IF NOT EXISTS handover_day text;

COMMIT;
