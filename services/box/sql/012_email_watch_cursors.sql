-- 012_email_watch_cursors.sql
-- Per-mailbox poll watermark for the email watcher (Tyche-style perpetual tick). Lets the
-- watcher poll `after:<last_polled_at>` instead of refetching the whole inbox each tick.
-- Watermark in unix SECONDS (Gmail's after: granularity). This is an optimisation only —
-- exactly-once is enforced by workflow_jobs.correlation_key, not this cursor.
-- Applied BY HAND on the box (no auto-migrate). Idempotent-safe to re-run.
CREATE TABLE IF NOT EXISTS email_watch_cursors (
  watcher        text   NOT NULL,            -- cursor namespace, e.g. 'saga-email'
  principal      text   NOT NULL,            -- ADR-0009 attribution, e.g. 'U_BENDIK'
  email_address  text   NOT NULL,            -- the mailbox being watched
  last_polled_at bigint NOT NULL DEFAULT 0,  -- unix seconds; gmail after: filter
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watcher, principal, email_address)
);
