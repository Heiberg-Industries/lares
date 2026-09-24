-- ORB-76 — email→draft rebuilt natively on eve (Option A: eve-saga owns Gmail polling
-- directly, replacing BOTH the old runtime's email-watcher container and saga-workflow's
-- triage consumer, per Bendik's decision 2026-08-16).
--
-- email_triage_processed: the exactly-once guarantee. The primary key IS the dedup —
-- INSERT ... ON CONFLICT DO NOTHING RETURNING tells the caller whether this Gmail message id
-- was ever seen before, survives restarts, and needs no separate cursor to be correct (a
-- cursor is an optimization the old watcher used; this schedule re-scans a short rolling
-- window every tick instead and lets this table be the sole correctness mechanism).
CREATE TABLE email_triage_processed (
  mailbox          text        NOT NULL,
  gmail_message_id text        NOT NULL,
  principal        text        NOT NULL,  -- schema guard (tests/schema-principal.test.ts)
  outcome          text        NOT NULL,   -- 'drafted' | 'fyi' | 'automated' | 'error'
  processed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox, gmail_message_id)
);
CREATE INDEX email_triage_processed_recent_idx ON email_triage_processed (processed_at);
