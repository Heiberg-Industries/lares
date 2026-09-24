-- ORB-75 — Nora's outreach loop, ported into Saga (eve-saga) as a skill.
--
-- outreach_threads: tracks a sent outreach email so the reply-watch schedule
-- (services/chief-of-staff/agent/schedules/outreach-reply-watch.ts) knows which Gmail threads to
-- poll for a reply, and can stop polling once one is found or too much time has passed.
CREATE TABLE outreach_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    text        NOT NULL,
  account      text        NOT NULL,                 -- which mailbox sent it (e.g. owner@project.example)
  person_id    text,                                  -- Twenty person record id, when known
  status       text        NOT NULL DEFAULT 'awaiting_reply',
  sent_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CONSTRAINT outreach_threads_status_ck CHECK (status IN ('awaiting_reply','replied','stopped')),
  CONSTRAINT outreach_threads_thread_account_uk UNIQUE (thread_id, account)
);
CREATE INDEX outreach_threads_awaiting_idx ON outreach_threads (status) WHERE status = 'awaiting_reply';
