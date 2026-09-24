-- notion-sync state. Created in full at Phase 1 so later phases add logic, not
-- migrations: md_hash/notion_hash are unused until two-way sync (Phase 3).
-- frozen_reason/frozen_at ARE written today — recordMeetingUnmatched stores the
-- reason a row could not be matched, and the timestamp it was first flagged.
BEGIN;

CREATE TABLE IF NOT EXISTS notion_sync_docs (
  id                 BIGSERIAL PRIMARY KEY,
  -- NULL until a vault file is linked. Postgres allows many NULLs under UNIQUE.
  vault_path         TEXT UNIQUE,
  notion_page_id     TEXT NOT NULL UNIQUE,
  target             TEXT NOT NULL CHECK (target IN ('docs', 'meetings')),
  direction          TEXT NOT NULL CHECK (direction IN ('two_way', 'md_to_notion', 'notion_to_md')),
  md_hash            TEXT,
  notion_hash        TEXT,
  notion_last_edited TIMESTAMPTZ,
  -- 'retrying' = the write failed at least once but has not yet hit the third strike
  -- that makes it an incident. Without it a page that NEVER succeeded would read as
  -- 'synced' for its first two failures, which is simply untrue.
  state              TEXT NOT NULL DEFAULT 'synced'
                     CHECK (state IN ('synced', 'frozen', 'error', 'unmatched', 'retrying')),
  frozen_reason      TEXT,
  frozen_at          TIMESTAMPTZ,
  error_count        INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The console only ever lists rows needing attention, so index just those.
CREATE INDEX IF NOT EXISTS notion_sync_docs_attention_idx
  ON notion_sync_docs (state) WHERE state <> 'synced';

-- Singleton run watermark. The CHECK (id) forces exactly one row.
CREATE TABLE IF NOT EXISTS notion_sync_run (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_commit TEXT,
  last_run_at TIMESTAMPTZ
);

INSERT INTO notion_sync_run (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

COMMIT;
