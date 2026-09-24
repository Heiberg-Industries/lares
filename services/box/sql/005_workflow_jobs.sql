-- 005_workflow_jobs.sql
-- The durable-workflow primitive: one row per running multi-step job.
-- Generalizes task_state (the JSON checkpoint) + trigger_schedules (due scheduling)
-- into a resumable, step-indexed job. The runner polls due rows like the reminders loop.
CREATE TABLE workflow_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent         text        NOT NULL,                     -- owning agent ('nora', ...)
  principal     text,                                     -- ADR-0009 user attribution
  workflow_type text        NOT NULL,                     -- which WorkflowDefinition ('outreach', ...)
  state         jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- JSON checkpoint carried between steps
  step_index    integer     NOT NULL DEFAULT 0,           -- which step to run next
  status        text        NOT NULL DEFAULT 'pending', -- pending|running|waiting|done|failed
  due_at        timestamptz NOT NULL DEFAULT now(),       -- when the job is next runnable
  wait_event    text,                                     -- if waiting on an event, its key; else NULL
  result        jsonb,                                    -- set when status='done'
  error         text,                                     -- set when status='failed'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_step_at  timestamptz,
  CONSTRAINT workflow_jobs_status_ck
    CHECK (status IN ('pending','running','waiting','done','failed'))
);
-- The runner's hot query: time-due jobs not blocked on an event.
CREATE INDEX workflow_jobs_due_idx ON workflow_jobs (due_at)
  WHERE wait_event IS NULL AND status IN ('pending','waiting');
-- Event wakeups: find the job waiting on a given (agent, event).
CREATE INDEX workflow_jobs_event_idx ON workflow_jobs (agent, wait_event)
  WHERE wait_event IS NOT NULL;
