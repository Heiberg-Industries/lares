-- 001_init.sql — agent box state store
-- Applied once on first Postgres init (mounted into /docker-entrypoint-initdb.d).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Agent conversation sessions (Agent SDK session id <-> door thread).
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text        NOT NULL,                 -- 'saga', ...
  door         text        NOT NULL,                 -- 'slack' | 'telegram' | 'email' | 'cli'
  thread_ref   text        NOT NULL,                 -- door-native thread id
  sdk_session  text,                                 -- Agent SDK resumable session id
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent, door, thread_ref)
);

-- Pending human confirmations (the 👍-gate), per the never-list/confirm design.
CREATE TABLE confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        REFERENCES sessions(id) ON DELETE CASCADE,
  action       text        NOT NULL,                 -- 'send_email' | 'twenty_write' | ...
  args         jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CONSTRAINT confirmations_status_ck
    CHECK (status IN ('pending','approved','rejected','expired'))
);

-- Reminders (closes Saga's gap; the daemon delivers due rows).
CREATE TABLE reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text        NOT NULL,                 -- owning agent
  owner        text        NOT NULL,-- who it's for
  due_at       timestamptz NOT NULL,
  recurrence   text,                                 -- NULL = one-shot; else 'daily'|'weekly'|RRULE
  payload      jsonb       NOT NULL,                 -- {text, door, thread_ref}
  status       text        NOT NULL DEFAULT 'pending', -- pending|delivered|cancelled|failed
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,                 -- session/agent that created it
  CONSTRAINT reminders_status_ck
    CHECK (status IN ('pending','delivered','cancelled','failed'))
);
CREATE INDEX reminders_due_idx ON reminders (status, due_at);

-- Scheduled triggers (cron-style; pg-boss runs them, this records intent/ownership).
CREATE TABLE trigger_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text        NOT NULL,
  name         text        NOT NULL,                 -- 'morning_brief' | 'radar_run' | ...
  cron         text        NOT NULL,                 -- UTC cron expression
  enabled      boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent, name)
);

-- Append-only audit log (every outbound action + confirmation). Shipped off-box.
CREATE TABLE audit (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  agent        text        NOT NULL,
  session_id   uuid,
  action       text        NOT NULL,
  credential   text,                                 -- WHICH key/scope (name only, never the secret)
  args_summary text,                                 -- redacted summary, not raw payload
  confirm_id   uuid                                  -- the confirmation that authorised it, if any
);
-- Append-only: the agent's DB role gets INSERT + SELECT only (granted at deploy time, Stage 2 Task 4).
