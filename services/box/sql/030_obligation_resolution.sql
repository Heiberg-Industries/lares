-- 030_obligation_resolution.sql — ORB-45 Task 10. Pointers only: WHEN a thread was found answered
-- elsewhere and BY WHAT (a channel name + a one-line evidence string with a date), and the
-- intent read of its last message, keyed to that message's timestamp so it is never re-read.
-- Hand-applied; idempotent; one transaction.
BEGIN;
ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS resolved_elsewhere_at TIMESTAMPTZ;
ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS resolution_via        TEXT;
ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS resolution_evidence   TEXT;   -- "you emailed her 2026-08-15 14:02" — a sentence, never a body
ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS intent                TEXT CHECK (intent IN ('expects_reply','closes_loop','fyi','unreadable'));
ALTER TABLE obligation_threads ADD COLUMN IF NOT EXISTS intent_for_message_at TIMESTAMPTZ;
COMMIT;
