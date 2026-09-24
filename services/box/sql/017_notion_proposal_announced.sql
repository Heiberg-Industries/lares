-- ORB-38 / spec §20.3 — the Saga approvals hand needs to know which proposals she has
-- already DM'd Bendik about.
--
-- Why a column and not process memory: Saga polls on her existing schedule, and an
-- in-process Set would re-announce every open proposal on every restart and every
-- deploy — the fastest way to teach a human to ignore a notification. announced_at
-- makes "has been announced" a durable property of the proposal itself, so exactly
-- one DM goes out per proposal no matter how many times the service restarts.
--
-- It is also what makes the spine's retiring proposal ping safe (§20.4): a proposal
-- still 'pending' long after announced_at is a case where the NEW surface failed to
-- get a decision, and that — not routine traffic — is what now escalates to
-- #lares-alerts.
--
-- Applied BY HAND on the agent box: there is no auto-migrate there. Idempotent, so a
-- re-run is safe.

BEGIN;

ALTER TABLE notion_sync_proposals
  ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ;

-- The poll's exact predicate. Partial, because the interesting set is tiny and
-- transient (usually zero rows) while the table accumulates resolved history.
CREATE INDEX IF NOT EXISTS notion_sync_proposals_unannounced
  ON notion_sync_proposals (created_at)
  WHERE state = 'pending' AND announced_at IS NULL;

COMMIT;
