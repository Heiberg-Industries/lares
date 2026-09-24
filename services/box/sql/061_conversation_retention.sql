-- 061_conversation_retention.sql — ADR-0020 rule 3. Twelve months by default; the owner may
-- shorten it, lengthen it, or choose "keep forever".
--
-- NULL means keep forever, and that is why `months` is nullable with no DEFAULT: a row that
-- exists says something deliberate, and a missing row means "nobody has chosen" — which
-- lib/conversation-record.ts reads as twelve, once, in code rather than in two places.
-- The CHECK refuses 0 and negatives: a zero would read as "delete everything tonight", and no
-- console slider should be able to produce it.
--
-- This setting does NOT govern eve's own workflow tables (ADR-0020 rule 5). Those are pruned
-- on their own schedule, once a session is closed — see the finding written under wave 3B.
--
-- Self-contained; hand-applied; idempotent; one transaction. Styled after sql/050.
BEGIN;

CREATE TABLE IF NOT EXISTS conversation_retention (
  owner      text PRIMARY KEY,
  months     integer,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_retention_months_check CHECK (months IS NULL OR months >= 1)
);

COMMIT;
