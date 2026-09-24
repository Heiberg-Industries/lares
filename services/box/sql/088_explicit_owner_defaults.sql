-- Require explicit ownership on new writes. Existing row values are never changed.
-- Role-specific tables may be absent in an installation; alter only present columns.
BEGIN;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('reminders', 'owner'),
    ('email_triage_processed', 'principal'),
    ('telegram_daily_log', 'principal'),
    ('telegram_session_rotation', 'principal'),
    ('outreach_threads', 'principal'),
    ('meeting_followup_sent', 'principal'),
    ('deadlines', 'owner'),
    ('deadline_candidates', 'owner'),
    ('standing_facts', 'user_id')
  ) AS columns_to_change(table_name, column_name)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = item.table_name
        AND c.column_name = item.column_name) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', item.table_name, item.column_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
