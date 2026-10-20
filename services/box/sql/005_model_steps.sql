-- 005_model_steps.sql: what each model call cost, kept locally.
--
-- WHAT THIS IS. Every time an agent's model answers, eve reports how many tokens went in and out,
-- and how many of the input tokens the provider served from its cache instead of billing in full.
-- One row per model call lands here, so the console can later say how often the prompt cache hits.
-- The row is numbers and ids only: no message text, no tool input, nobody's words.
--
--   event_id   eve's unique id for the "step completed" event. A replay of the same event cannot
--              add a second row.
--   agent      the agent that made the call.
--   session_id, turn_id, step_index
--              where in the conversation the call happened.
--   *_tokens   NULL when the provider did not report that number (not the same as zero).
--   at         when eve emitted the event.
--
-- RETENTION. Rows older than 90 days are removed by the writer (packages/agent-kit/src/
-- model-usage.ts) right after it inserts. There is no job to schedule.
--
-- SAFE TO RUN AGAIN. Only creates what is missing; no row is changed.

BEGIN;

CREATE TABLE IF NOT EXISTS model_steps (
    event_id           TEXT        PRIMARY KEY CHECK (event_id <> ''),
    agent              TEXT        NOT NULL CHECK (agent <> ''),
    session_id         TEXT        NOT NULL,
    turn_id            TEXT        NOT NULL,
    step_index         INTEGER     NOT NULL,
    input_tokens       BIGINT,
    output_tokens      BIGINT,
    cache_read_tokens  BIGINT,
    cache_write_tokens BIGINT,
    cost_usd           NUMERIC,
    at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_steps_agent_at_idx ON model_steps (agent, at DESC);

COMMIT;
