-- Bind native track-routing approval cards to the exact route proposal and DM audience.
-- The approval payload remains hashed in approval_asks; this table stores only route identity
-- and the already-verified, write-time private audience needed to process a later decline.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS route_proposals_one_pending_signal_idx
  ON route_proposals(person_id,signal_ref) WHERE status='pending';

CREATE TABLE IF NOT EXISTS route_proposal_approval_links (
  request_id text PRIMARY KEY REFERENCES approval_asks(request_id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 256),
  request_turn_sequence integer NOT NULL CHECK (request_turn_sequence >= 0),
  member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  door text NOT NULL CHECK (door IN ('slack', 'telegram')),
  audience_address text NOT NULL CHECK (length(audience_address) BETWEEN 1 AND 256),
  audience_access_revision bigint NOT NULL CHECK (audience_access_revision > 0),
  tool_name text NOT NULL CHECK (tool_name IN ('track_add_item', 'track_move_item')),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  person_id text,
  contact_person_id text,
  opportunity_id text,
  home text NOT NULL,
  track_id text NOT NULL,
  proposed_stage text NOT NULL,
  signal_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  declined_at timestamptz,
  question_pending boolean NOT NULL DEFAULT false,
  question_claimed_at timestamptz,
  question_sent_at timestamptz,
  question_reply_anchor text,
  answered_at timestamptz,
  CHECK ((tool_name = 'track_add_item' AND person_id IS NOT NULL AND opportunity_id IS NULL)
      OR (tool_name = 'track_move_item' AND person_id IS NULL AND opportunity_id IS NOT NULL))
);

ALTER TABLE route_proposal_approval_links
  ADD COLUMN IF NOT EXISTS question_reply_anchor text;

ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS route_person_id text;
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS route_home text;
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS route_track_id text;
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS route_choice text;
DO $$ BEGIN
  ALTER TABLE standing_facts ADD CONSTRAINT standing_facts_route_scope_shape_check CHECK (
    (route_person_id IS NULL AND route_home IS NULL AND route_track_id IS NULL AND route_choice IS NULL)
    OR (route_person_id IS NOT NULL AND route_home IS NOT NULL AND route_track_id IS NOT NULL
        AND route_choice IS NOT NULL AND route_choice IN ('never','not_now'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS route_proposal_approval_links_member_idx
  ON route_proposal_approval_links(member_id, audience_address, audience_access_revision, created_at DESC);

CREATE INDEX IF NOT EXISTS route_proposal_approval_links_open_question_idx
  ON route_proposal_approval_links(member_id, audience_address, session_id)
  WHERE declined_at IS NOT NULL AND question_sent_at IS NOT NULL AND answered_at IS NULL;

COMMIT;
