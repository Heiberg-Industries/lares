-- 071_agent_notes.sql — the agent's own notes area (ADR-0018 rule 9's `save_note`).
--
-- ADD-ONLY BY CONSTRUCTION, not by convention: there is no `updated_at`, no status column and
-- nothing to edit. A note that is wrong is superseded by a newer note, exactly as a standing
-- fact is; nothing here is ever rewritten, and nothing outside this file may delete a row
-- except an erase-a-person routine (ADR-0017 rule 8), which owns every member table equally.
--
-- WHY A TABLE AND NOT A MARKDOWN FILE. `_meta/` is excluded from vault search
-- (packages/agent-kit/src/notes-store.ts:30, kept by ADR-0017 rule 1), so a note written there
-- would be unfindable; and duties.md/voice.md are definition files, read at session start and
-- hashed (packages/agent-kit/src/definition.ts:143), so an agent cannot append to them without
-- changing its own definition hash mid-conversation.
--
-- ORIGIN IS NOT CONSTRAINED to one class, unlike standing_facts: a note written on a turn that
-- has read someone else's words is legitimately `third_party`, and it must be STORED as such
-- rather than refused — the point of a note is that it can carry what a fact may not.
-- What origin buys is that nothing third-party ever reaches the per-session core.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS agent_notes (
  id         bigserial PRIMARY KEY,
  owner      text        NOT NULL,
  agent      text        NOT NULL,
  kind       text        NOT NULL,
  note       text        NOT NULL,
  origin     text        NOT NULL,
  session_id text        NOT NULL,
  turn_id    text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_notes_kind_check CHECK (kind IN ('working', 'watch', 'followup')),
  CONSTRAINT agent_notes_origin_check
    CHECK (origin IN ('owner', 'agent', 'synced', 'third_party', 'system')),
  CONSTRAINT agent_notes_note_check CHECK (length(note) BETWEEN 1 AND 400)
);

CREATE INDEX IF NOT EXISTS agent_notes_session_idx ON agent_notes (session_id, id);
CREATE INDEX IF NOT EXISTS agent_notes_owner_idx   ON agent_notes (owner, at DESC, id DESC);

COMMIT;
