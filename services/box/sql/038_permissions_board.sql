-- 038_permissions_board.sql — the permissions board (ORB-278 step 1, agent-definitions spec Part 4).
-- Apply by hand on the box (no auto-migrate). Idempotent.

-- Every change to a permission, whoever made it (console, meeting-series page, a hand UPDATE): the
-- trigger records old → new, so the audit cannot be skipped by a writer that forgets to write one.
CREATE TABLE IF NOT EXISTS ratchet_audit (
  id          bigserial   PRIMARY KEY,
  agent       text        NOT NULL,
  capability  text        NOT NULL,
  action      text        NOT NULL,
  old_level   text,
  new_level   text,
  changed_by  text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ratchet_audit_key_idx ON ratchet_audit (agent, capability, id DESC);

-- A DELETE has no updated_by column to read. Whoever deletes a ratchet row must first
-- `SET lares.actor = '<who>'` in the same session (the Task-10 reconciliation does);
-- without it the audit row says 'unknown'.
CREATE OR REPLACE FUNCTION ratchet_audit_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO ratchet_audit (agent, capability, action, old_level, new_level, changed_by)
    -- nullif: a SET-then-RESET actor reads back as '' rather than NULL.
    VALUES (OLD.agent, OLD.capability, OLD.action, OLD.level, NULL, coalesce(nullif(current_setting('lares.actor', true), ''), 'unknown'));
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.level = NEW.level THEN RETURN NEW; END IF;
  INSERT INTO ratchet_audit (agent, capability, action, old_level, new_level, changed_by)
  VALUES (NEW.agent, NEW.capability, NEW.action, CASE WHEN TG_OP = 'UPDATE' THEN OLD.level END, NEW.level, NEW.updated_by);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ratchet_audit_trg ON ratchet;
CREATE TRIGGER ratchet_audit_trg AFTER INSERT OR UPDATE OR DELETE ON ratchet
  FOR EACH ROW EXECUTE FUNCTION ratchet_audit_fn();

-- What the approval policy decided, per call — the board's evidence ("asked 12×, ran on its own 3×").
-- call_id is eve's id for the call: eve consults the policy again when an answered card resumes, with
-- the same id, so one card is one row (the writer inserts ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS approval_events (
  id          bigserial   PRIMARY KEY,
  agent       text        NOT NULL,
  capability  text        NOT NULL,
  tool        text        NOT NULL,
  decision    text        NOT NULL CHECK (decision IN ('asked', 'autonomous', 'denied', 'locked', 'failed-closed')),
  reason      text,
  call_id     text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_events_key_idx ON approval_events (agent, capability, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS approval_events_call_idx ON approval_events (call_id) WHERE call_id IS NOT NULL;

-- One row per agent, written by the agent itself at start. The console lists agents from here.
CREATE TABLE IF NOT EXISTS agent_registry (
  name          text        PRIMARY KEY,
  display_name  text        NOT NULL,
  role          text,
  grants        jsonb       NOT NULL,
  autonomy      jsonb       NOT NULL,
  skills        jsonb       NOT NULL DEFAULT '[]',
  doors         jsonb       NOT NULL DEFAULT '[]',
  tools         jsonb,
  started_at    timestamptz NOT NULL DEFAULT now()
);
