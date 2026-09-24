-- ORB-156 — the meeting follow-up send log.
--
-- ONE table doing four jobs, deliberately (spec Q3): it is the exactly-once guarantee, the
-- per-tick billed-call ceiling's counter, the memory the polling trigger reads instead of
-- diffing Notion property values across ticks, and the audit trail behind the "what I did"
-- Slack line. A second table beside it would be a second place for the same fact to be wrong.
--
-- The claim/retry shape is email_triage_processed's (sql/022, sql/024) verbatim, for the same
-- reason: a bare ON CONFLICT DO NOTHING makes "already claimed" and "permanently failed"
-- indistinguishable, and a transient failure then silently drops a real follow-up forever.
CREATE TABLE meeting_followup_sent (
  notion_page_id          text        NOT NULL,
  principal               text        NOT NULL,  -- schema guard (tests/schema-principal.test.ts)
  series_key              text        NOT NULL DEFAULT '',        -- '' = a one-off meeting
  outcome                 text        NOT NULL,   -- 'sent' | 'queued' | 'skipped' | 'error'
  -- 'queued' (ORB-156 fix round 2): the schedule's turn dispatched successfully but the tool
  -- has not necessarily executed yet (a card may still be pending human approval) — only
  -- meeting_followup_send's own execute() ever writes 'sent', because only it knows mail
  -- actually left. Comment-only change; the column itself has always been free text.
  -- sha256 of the sorted, lower-cased recipient list. The pause-and-ask rule (spec Q3) reads
  -- the most recent row for a series and compares: a series that gains an external must not
  -- send autonomously to a set Bendik never approved.
  recipients_fingerprint  text        NOT NULL DEFAULT '',
  recipients              text        NOT NULL DEFAULT '',        -- the audit trail, human-readable
  attempts                integer     NOT NULL DEFAULT 1,
  processed_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notion_page_id)
);
CREATE INDEX meeting_followup_sent_recent_idx ON meeting_followup_sent (processed_at);
-- The pause-and-ask lookup is "most recent SENT row for this series".
CREATE INDEX meeting_followup_sent_series_idx ON meeting_followup_sent (series_key, processed_at DESC)
  WHERE outcome = 'sent';
