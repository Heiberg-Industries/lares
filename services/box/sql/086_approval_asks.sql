-- 086_approval_asks.sql — one row per approval CARD: what was asked, and what the owner answered.
--
-- WHY NOT approval_events (038). That table records what the POLICY decided — asked, autonomous,
-- denied, locked, failed-closed — one row per call id. "asked" means a card was rendered. It has
-- never recorded what happened next, so nothing in this installation can say how often the owner
-- says yes, and nothing can tell a card that was refused from one that was never answered. Two
-- tables, two questions; 038 is untouched.
--
-- KEYED ON eve's REQUEST ID, WITH THE CALL ID UNIQUE BESIDE IT. The request id is what an answer
-- arrives under (input.resolved); the call id is what survives the durable park between the card
-- and the tool's execute, and is therefore what a freshness or payload check has to look under.
--
-- payload_hash IS A HASH, NOT THE PAYLOAD. What the owner was shown is a mail body, a note, a
-- recipient list — someone's words. This table is evidence about the gate, never a second copy of
-- the message. Nothing here can be quoted back.
--
-- NO PERSON COLUMN. `answered_via` names the DOOR ("telegram", "slack"), never a person: the
-- installation's approver list is still env-configured per channel, and a door-native id here
-- would be a new free-text person key of exactly the kind services/box/lib/member-scope.ts
-- forbids. When the approver list becomes a member list (multi-user, after launch) this table
-- gains `member text` of kind `registry` and a migration to fill it.
--
-- USE COUNTING (W7A-s5b), NOT ENFORCEMENT. Nobody has yet observed, on a live box, whether eve's
-- durable-replay path (`shouldPrepareApprovalReplayTools`) ever re-runs an approved tool call —
-- and this table has no execution marker, so a second execution of the same call id cannot be
-- told from the first without one. `used_at`/`use_count` COUNT and the code WARNS about a repeat;
-- nothing here refuses it. Whether a second use should be blocked is a later decision, made once
-- these numbers exist on a real installation, not guessed at now.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS approval_asks (
  request_id   text        PRIMARY KEY,
  call_id      text        NOT NULL,
  agent        text        NOT NULL,
  tool         text        NOT NULL,
  payload_hash text        NOT NULL,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  outcome      text,
  answered_via text,
  CONSTRAINT approval_asks_outcome_check CHECK (
    outcome IS NULL OR outcome IN
      ('approved', 'cancelled', 'ignored', 'invalid', 'expired', 'payload-changed')),
  CONSTRAINT approval_asks_answered_check CHECK ((answered_at IS NULL) = (outcome IS NULL))
);

ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;

-- The freshness and payload checks look up by call id (see the header).
CREATE UNIQUE INDEX IF NOT EXISTS approval_asks_call_idx ON approval_asks (call_id);
-- The rate, per agent and tool, over a window.
CREATE INDEX IF NOT EXISTS approval_asks_tool_idx ON approval_asks (agent, tool, asked_at DESC);

COMMIT;
