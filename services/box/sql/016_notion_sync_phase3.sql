-- Phase 3 (two-way desk sync) additions. 015 already carries what Phase 3 needs on
-- notion_sync_docs itself — direction 'two_way'/'notion_to_md' and state 'frozen'
-- were provisioned ahead of use back in Phase 1 — but the 👍 proposal queue and the
-- fidelity gate (spec §4.5/§18.3, §18.6) were not anticipated and need their own
-- tables.
--
-- Amended 2026-08-04 (T6 review, F2) — UNSHIPPED at the time, so edited in place
-- rather than added as a follow-up migration: notion_sync_proposals gains
-- diff_preview, so the compact "what changed" preview pull-sync.ts/cli.ts already
-- compute at propose time is PERSISTED, not just pinged and discarded — the
-- console (no vault mount, so it cannot re-derive a diff from the file) needs it
-- to satisfy spec §18.4's "diff visible" contract on its Approve/Reject card.
BEGIN;

CREATE TABLE IF NOT EXISTS notion_sync_proposals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vault_path     TEXT NOT NULL,
  notion_page_id TEXT NOT NULL,
  proposed_body  TEXT NOT NULL,          -- reverse-translated Obsidian md (body only)
  base_md_hash   TEXT NOT NULL,          -- vault render-hash when proposed
  notion_hash    TEXT NOT NULL,          -- hash of the GET /markdown that proposed it
  diff_preview   TEXT NOT NULL DEFAULT '', -- compact before/after preview, captured at propose time
  state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','approved','rejected','applied','superseded')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS notion_sync_proposals_open
  ON notion_sync_proposals (vault_path)
  WHERE state IN ('pending','approved');   -- one open proposal per file
CREATE TABLE IF NOT EXISTS notion_sync_fidelity (
  vault_path TEXT PRIMARY KEY,
  passed     BOOLEAN NOT NULL,
  reason     TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
