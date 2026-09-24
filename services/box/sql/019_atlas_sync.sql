-- ORB-4 Part B — the Atlas sync job's state.
--
-- Its OWN tables, deliberately not an extension of notion_sync_proposals (spec §4.3).
-- That table has THREE NOT NULL columns that are meaningless for a note derived from a
-- repo file, a vault file or a Notion page treated as a source rather than a mirror
-- (notion_page_id, base_md_hash, notion_hash), and its partial unique index is on
-- vault_path in a different namespace. Relaxing any of them would weaken invariants on a
-- live state machine whose race-fix (resolveProposal as ONE guarded UPDATE) took real
-- debugging to get right. What IS shared is the FACE: the DM-with-buttons presentation.
--
-- Applied BY HAND on the agent box, BEFORE the image: every proposal query names these
-- tables, and the reverse order hard-fails the tick AND the button callback (ORB-39).
-- Idempotent, so a re-run is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS atlas_notes (
  note_path              TEXT PRIMARY KEY,   -- Atlas-relative, e.g. _projects/soma.md
  brand                  TEXT,
  -- The source fingerprint this note has ACCOUNTED FOR: applied, OR looked at and
  -- declined. THE field that stops re-proposal. A rejected draft advances it exactly like
  -- an approved one — without that, the next tick re-proposes the text Bendik just said no
  -- to, daily, forever (the notion-sync recordNotionAccounted lesson).
  accounted_sources_hash TEXT,
  -- The narrative body as last written or last seen. Re-checked at apply time so a
  -- proposal approved after the note moved underneath it is superseded, not applied blind.
  body_hash              TEXT,
  -- 'sources_failed' = at least one source could NOT BE READ (network, proxy denial, auth,
  -- 5xx). 'sources_missing' = at least one source is genuinely GONE (404 / absent file).
  -- They are different facts with different consequences and no code path may collapse
  -- them: a blocked egress call that reads as "the file is empty" is the ORB-51 defect
  -- class, and here it would silently propose a note with its content removed.
  state                  TEXT NOT NULL DEFAULT 'ok'
                         CHECK (state IN ('ok','sources_failed','sources_missing')),
  state_reason           TEXT,
  -- When the CURRENT state was first entered. Pings fire on TRANSITION only, so a source
  -- that stays unreachable for a week is one message, not seven.
  state_since            TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS atlas_notes_attention_idx
  ON atlas_notes (state) WHERE state <> 'ok';

CREATE TABLE IF NOT EXISTS atlas_proposals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_path      TEXT NOT NULL,
  -- The FULL proposed file (frontmatter + body), not a patch. The apply pass writes bytes
  -- it was shown rather than re-deriving them, so what Bendik approved is what lands.
  proposed_note  TEXT NOT NULL,
  base_body_hash TEXT NOT NULL,
  -- Becomes accounted_sources_hash on EITHER decision.
  sources_hash   TEXT NOT NULL,
  diff_preview   TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','approved','rejected','applied','superseded')),
  announced_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- "The decision has been EXECUTED" — not "a human decided". Both an approve and a
  -- reject still owe the world a write (a file, or the accounted-for stamp), and that NULL
  -- is the apply pass's work queue.
  resolved_at    TIMESTAMPTZ
);

-- One OPEN claim per note, whatever it is asking for. Two live claims on one file would
-- mean whichever applied second either overwrote the other or was refused as stale.
CREATE UNIQUE INDEX IF NOT EXISTS atlas_proposals_open
  ON atlas_proposals (note_path) WHERE state IN ('pending','approved');

CREATE INDEX IF NOT EXISTS atlas_proposals_unannounced
  ON atlas_proposals (created_at) WHERE state = 'pending' AND announced_at IS NULL;

COMMIT;
