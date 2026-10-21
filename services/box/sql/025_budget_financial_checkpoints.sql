-- Inactive owned-transaction checkpoint. This is NOT a host recovery witness,
-- comprehensive mutation guard or database-role isolation boundary.
BEGIN;
CREATE TABLE IF NOT EXISTS budget_financial_checkpoints (
  operation_id uuid PRIMARY KEY,
  journal_id uuid NOT NULL,
  proposal_sequence bigint NOT NULL CHECK(proposal_sequence>0),
  proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[a-f0-9]{64}$'),
  UNIQUE(journal_id,proposal_sequence)
);
CREATE OR REPLACE FUNCTION budget_financial_checkpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial checkpoint is immutable'; END $$;
DROP TRIGGER IF EXISTS budget_financial_checkpoint_immutable ON budget_financial_checkpoints;
CREATE TRIGGER budget_financial_checkpoint_immutable BEFORE UPDATE OR DELETE ON budget_financial_checkpoints FOR EACH ROW EXECUTE FUNCTION budget_financial_checkpoint_immutable();
COMMIT;
