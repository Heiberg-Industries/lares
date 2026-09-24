-- 002_task_state.sql
-- Per-task checkpointing for long autonomous runs (radar, briefings).
-- Resumes a WORK-LIST, distinct from sdk_session which resumes a CONVERSATION.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_state jsonb;
