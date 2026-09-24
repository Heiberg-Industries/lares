-- 011_workflow_correlation_key.sql
-- The event-trigger primitive's exactly-once key: an external event (an email message-id,
-- later a meeting/signal id) maps to AT MOST ONE workflow job. Nullable so legacy createJob
-- rows (NULL key) are unaffected; the partial unique index ignores NULLs, so only
-- correlation-keyed starts are deduped. Applied BY HAND on the box (no auto-migrate).
-- Idempotent-safe to re-run.
ALTER TABLE workflow_jobs ADD COLUMN IF NOT EXISTS correlation_key text;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_jobs_correlation_uk
  ON workflow_jobs (agent, workflow_type, correlation_key)
  WHERE correlation_key IS NOT NULL;
