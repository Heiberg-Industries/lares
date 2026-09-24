-- 034_email_triage_draft_id.sql — remember which Gmail draft the triage created for which thread.
--
-- 2026-09-08, Bendik: recipients of a drafted reply must be editable "both via Gmail AND by
-- telling Saga". Gmail already works (it is a normal draft). Telling Saga needs the draft id:
-- `gmail_draft_recipients` (agent/tools) resolves "the reply to Stefan" to a draft by thread and
-- rewrites its To/Cc headers in place. Both columns are nullable — rows written before this
-- migration, and non-drafted outcomes, simply have none.
--
-- Apply by hand on the agent box (no auto-migrate):
--   docker compose exec -T db psql -U lares -d lares_state -f - < services/box/sql/034_email_triage_draft_id.sql
ALTER TABLE email_triage_processed ADD COLUMN IF NOT EXISTS draft_id  text;
ALTER TABLE email_triage_processed ADD COLUMN IF NOT EXISTS thread_id text;
CREATE INDEX IF NOT EXISTS email_triage_processed_thread_idx ON email_triage_processed (mailbox, thread_id) WHERE draft_id IS NOT NULL;
