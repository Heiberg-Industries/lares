/**
 * The Notion + Atlas proposal tables, mirroring `services/box/sql/015-019` — moved here
 * (ORB-175 Task 4) out of `tests/proposals.test.ts`, which held this block inline, so the
 * mirror exists exactly once. `tests/proposals.test.ts` and
 * `tests/schedule-heartbeat-wiring.test.ts` both apply it against their own disposable
 * testcontainer Postgres.
 */
export const PROPOSALS_SCHEMA = `
CREATE TABLE notion_sync_docs (
  id                 BIGSERIAL PRIMARY KEY,
  vault_path         TEXT UNIQUE,
  notion_page_id     TEXT NOT NULL UNIQUE,
  target             TEXT NOT NULL CHECK (target IN ('docs', 'meetings')),
  direction          TEXT NOT NULL CHECK (direction IN ('two_way', 'md_to_notion', 'notion_to_md')),
  md_hash            TEXT,
  notion_hash        TEXT,
  notion_last_edited TIMESTAMPTZ,
  state              TEXT NOT NULL DEFAULT 'synced'
                     CHECK (state IN ('synced', 'frozen', 'error', 'unmatched', 'retrying')),
  frozen_reason      TEXT,
  frozen_at          TIMESTAMPTZ,
  error_count        INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notion_sync_proposals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vault_path     TEXT NOT NULL,
  notion_page_id TEXT NOT NULL,
  proposed_body  TEXT NOT NULL,
  base_md_hash   TEXT NOT NULL,
  notion_hash    TEXT NOT NULL,
  diff_preview   TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('update','create')),
  state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','approved','rejected','applied','superseded')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  announced_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX notion_sync_proposals_open
  ON notion_sync_proposals (vault_path) WHERE state IN ('pending','approved');

CREATE TABLE atlas_notes (
  note_path              TEXT PRIMARY KEY,
  brand                  TEXT,
  accounted_sources_hash TEXT,
  body_hash              TEXT,
  state                  TEXT NOT NULL DEFAULT 'ok'
                         CHECK (state IN ('ok','sources_failed','sources_missing')),
  state_reason           TEXT,
  state_since            TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE atlas_proposals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_path      TEXT NOT NULL,
  proposed_note  TEXT NOT NULL,
  base_body_hash TEXT NOT NULL,
  sources_hash   TEXT NOT NULL,
  diff_preview   TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','approved','rejected','applied','superseded')),
  announced_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX atlas_proposals_open
  ON atlas_proposals (note_path) WHERE state IN ('pending','approved');
`;
