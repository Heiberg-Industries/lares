-- Add mandatory principal columns. Refuse nonempty unscoped tables rather than
-- guessing ownership; such legacy data requires an explicit reviewed backfill.
ALTER TABLE telegram_daily_log ADD COLUMN principal text NOT NULL;
ALTER TABLE telegram_session_rotation ADD COLUMN principal text NOT NULL;
ALTER TABLE outreach_threads ADD COLUMN principal text NOT NULL;
