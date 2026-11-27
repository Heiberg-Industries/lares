-- 041_schedule_run.sql: what each scheduled job's last run did, and why.
--
-- WHAT THIS IS. The `heartbeat` table says whether a schedule is alive; monitoring reads it, and a
-- closed gate deliberately writes nothing there so that a dark schedule pages. It never said what a
-- person in the console needs to know: a run was asked for and is running, finished (with counts),
-- failed (with the message), or was skipped (with a reason). Those reasons went to the log only.
-- This table holds them: one row per job key (`<agent>/<schedule>`, the same keys the heartbeat
-- uses), overwritten by each new outcome. Written by `packages/agent-kit/src/schedule-heartbeat.ts`
-- (`recordRunStarted`, `recordRunFinished`, `recordRunFailed`, `recordRunSkipped`), read by the
-- console (`readScheduleRun`).
--
-- WHAT IT DOES NOT HOLD. No person column and no message text: `agent` is the agent's definition
-- name, `reason` is a short code, `detail` is a plain sentence or an error's own message, `counts`
-- are whole numbers. The heartbeat table and its rules are not touched.
--
-- SAFE TO RUN AGAIN. Only creates, and only if missing. Needs nothing the baseline does not create.
BEGIN;

CREATE TABLE IF NOT EXISTS schedule_run (
    job text PRIMARY KEY CHECK (job ~ '^[a-z0-9-]+/[a-z0-9-]+$'),
    agent text NOT NULL DEFAULT '',
    state text NOT NULL CHECK (state IN ('running', 'finished', 'failed', 'skipped')),
    reason text NOT NULL DEFAULT '' CHECK (reason = '' OR reason ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
    counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
    started_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- A skip has a reason; nothing else does.
    CONSTRAINT schedule_run_reason_only_on_skip CHECK ((state = 'skipped') = (reason <> ''))
);

COMMIT;
