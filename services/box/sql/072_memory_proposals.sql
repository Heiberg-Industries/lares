-- 072_memory_proposals.sql — an unattended change to a standing preference waits for the owner
-- (ADR-0018 rule 2). The third lane of the shape services/box/sql/019_atlas_sync.sql and
-- 015_notion_sync.sql already established; the columns differ, the states and the guarded
-- transition do not.
--
-- WHY A QUEUE AND NOT AN APPROVAL CARD DIRECTLY. The always-ask machinery
-- (packages/agent-kit/src/always-ask.ts, board-approval.ts) gates a MODEL TOOL CALL, and the
-- dream cycle makes none: it runs from a schedule and calls the store directly. So the card is
-- rendered later, by the tool the owner's agent calls to resolve a row here — the same
-- indirection atlas_resolve_proposal already uses.
--
-- NOTHING IS APPLIED BY THIS TABLE. A row here records an intention. The apply pass
-- (catalogue/memory_resolve_proposal.ts) is the only thing that closes a preference, and only
-- on an approval.
--
-- NO FOREIGN KEY to dream_preferences (or to standing_facts) on purpose: both are owned by the
-- role service, not by a numbered migration — dream_preferences is created at runtime by
-- ensureDreamTables (services/chief-of-staff/lib/dream/store.ts:92), so a box that applies 072
-- before the role container has ever started would fail on the constraint. `existing_id` is
-- stored as text so it can name a row in either table.
--
-- ORIGIN IS RESTRICTED TO 'owner', NOT THE FULL ORIGIN DOMAIN. The promotion gate
-- (@lares/agent-kit/learning) already refuses to build a proposal from anything else — this
-- CHECK repeats that guarantee at the table, so a future bug upstream cannot smuggle an
-- agent-, synced-, third-party- or system-origin observation into something the owner is asked
-- to approve as if it came from their own words (ADR-0018: "third-party content never becomes
-- memory").
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS memory_proposals (
  id            bigserial   PRIMARY KEY,
  action        text        NOT NULL,
  existing_id   text        NOT NULL,
  existing_text text        NOT NULL,
  proposed_text text        NOT NULL DEFAULT '',
  subject       text        NOT NULL DEFAULT '',
  origin        text        NOT NULL,
  source        text        NOT NULL,
  state         text        NOT NULL DEFAULT 'pending',
  announced_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_proposals_action_check CHECK (action IN ('supersede', 'retire')),
  CONSTRAINT memory_proposals_state_check
    CHECK (state IN ('pending', 'approved', 'rejected', 'applied', 'superseded')),
  CONSTRAINT memory_proposals_origin_check CHECK (origin = 'owner'),
  -- A supersede must say what would replace the row; a retire must not pretend to.
  CONSTRAINT memory_proposals_text_check CHECK (
    (action = 'supersede' AND length(proposed_text) > 0) OR
    (action = 'retire'    AND proposed_text = '')
  )
);

-- One open proposal per standing row: a second nightly run must not queue the same change twice.
CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_open_idx
  ON memory_proposals (existing_id) WHERE state IN ('pending', 'approved');

COMMIT;
