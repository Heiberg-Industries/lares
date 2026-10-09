-- 091_clipping.sql — saved-link import into the inbox (LAR-113, child a).
--
-- Two NEW tables; nothing here ALTERs or INSERTs into an older table, and there is no data to
-- preview, so (unlike 083-085) there is no dry-run SELECT. Standalone: no older-table
-- prerequisites in the hand-built runtime image probe (services/keeper/tests/runtime-image.probe.py
-- applies every file from 039 up on its own).
--
-- `clipping_sources` is a LIST: one row per place clips are read from, each with its own Notion
-- data source, its own mapped columns, an owner (`organisation`, or one member's register id) and
-- a visibility (`shared` or `private`). Where a clip lands follows the row's owner and
-- visibility, never the page's content. The first slice ACCEPTS EXACTLY ONE notion row (owner
-- `organisation`, visibility `shared`, credential `notion:shared`) and refuses anything else with
-- a plain reason; the engine enforces that, not this schema, so the later multi-member work needs
-- no migration to relax it. A `karakeep` row (kind) exists only so a Karakeep import can sit in
-- the ledger for cross-source duplicate checks; it is never read as a place to import from.
--
-- Property ids are Notion property ids, not names, so a renamed column keeps working.
--
-- `clipping_items` is the ledger: one row per (source, source item). The inbox file path is
-- derived from those two, so a crash between the file write and this row rewrites the same file,
-- never a second one. Metadata only: the link is kept as a normalised key, never the article.
--
-- Self-contained; hand-applied or via the migration runner; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS clipping_sources (
  id                  text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind                text        NOT NULL,
  data_source_id      text        NOT NULL,
  url_property_id     text        NOT NULL,
  note_property_id    text,
  tags_property_id    text,
  saved_property_id   text,
  credential_ref      text        NOT NULL DEFAULT 'notion:shared',
  -- No defaults for owner or visibility (box 088): every insert says whose clips these are.
  owner               text        NOT NULL,
  visibility          text        NOT NULL,
  -- Where a first pass starts. Older rows are a backlog; importing one is an explicit later
  -- opt-in (set this earlier by hand), never the default.
  import_since        timestamptz NOT NULL,
  -- State, one row per source (read by the console; unreadable there means "unavailable").
  watermark           timestamptz,
  watermark_capped    boolean     NOT NULL DEFAULT false,
  last_attempt_at     timestamptz,
  last_success_at     timestamptz,
  outcome             text,
  outcome_detail      text,
  last_counts         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  imported_total      integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clipping_sources_kind_check CHECK (kind IN ('notion', 'karakeep')),
  CONSTRAINT clipping_sources_visibility_check CHECK (visibility IN ('shared', 'private')),
  CONSTRAINT clipping_sources_owner_not_empty CHECK (length(btrim(owner)) > 0),
  CONSTRAINT clipping_sources_outcome_check CHECK (outcome IS NULL OR outcome IN (
    'ok', 'not-configured', 'unsupported-source', 'refused', 'not-shared',
    'schema-mismatch', 'rate-limited', 'unavailable', 'timeout', 'incomplete',
    'key-unreadable', 'local-error'
  )),
  -- A one-line owner sentence, never a vendor body or a token.
  CONSTRAINT clipping_sources_detail_short CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 400)
);

CREATE TABLE IF NOT EXISTS clipping_items (
  source_id        text        NOT NULL REFERENCES clipping_sources (id) ON DELETE CASCADE,
  source_item_id   text        NOT NULL,
  source_container text        NOT NULL,
  owner            text        NOT NULL,
  visibility       text        NOT NULL,
  url_key          text,
  source_revision  timestamptz,
  state            text        NOT NULL,
  skip_reason      text,
  inbox_path       text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  PRIMARY KEY (source_id, source_item_id),
  CONSTRAINT clipping_items_state_check CHECK (state IN ('imported', 'filed-unknown', 'trashed', 'skipped')),
  CONSTRAINT clipping_items_visibility_check CHECK (visibility IN ('shared', 'private')),
  CONSTRAINT clipping_items_skip_reason_check CHECK (skip_reason IS NULL OR skip_reason IN ('no-link', 'duplicate'))
);

-- Duplicate check: the same link, in the same inbox (owner + visibility), recently.
CREATE INDEX IF NOT EXISTS clipping_items_dup_idx
  ON clipping_items (owner, visibility, url_key, first_seen_at DESC)
  WHERE url_key IS NOT NULL AND state IN ('imported', 'filed-unknown');

-- The trash check walks the clips still waiting in the inbox, least recently checked first.
CREATE INDEX IF NOT EXISTS clipping_items_waiting_idx
  ON clipping_items (source_id, last_checked_at NULLS FIRST) WHERE state = 'imported';

COMMIT;
