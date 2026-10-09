-- 092_clipping_requests.sql — owner requests for the clipping card, and which source runs
-- (LAR-113, child b).
--
-- Two NEW tables; nothing here ALTERs or INSERTs into an older table, so (like 091) there is no
-- dry-run SELECT and no older-table prerequisite in the hand-built runtime image probe
-- (services/keeper/tests/runtime-image.probe.py applies every file from 039 up on its own).
--
-- `clipping_requests` is a small queue. The console cannot reach Notion (only the chief of staff
-- holds the key), so a button on the Clipping card writes a row here and the chief of staff picks
-- it up within a minute, does the Notion call, and writes the answer back in `result` and the
-- `outcome` columns. `kind` is what was asked: read a pasted database (`schema`), try the saved
-- mapping without importing (`test`), run an import now (`import`), add the Status / For / Origin
-- columns (`add-properties`). `params` holds ids and column ids, never a token. `result` holds
-- names and counts, never a token or a vendor body; `outcome` uses the same values as
-- `clipping_sources.outcome`. A row stuck in `claimed` or `pending` is reported by the console as
-- "not picked up" / "not finished" after ten minutes; it is never left spinning.
--
-- `clipping_choice` holds ONE row: which clipping source the digest reads (`notion`, `karakeep`
-- or `both`, the changeover). No row means today's behaviour: each source runs if it is set up.
--
-- Self-contained; hand-applied or via the migration runner; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS clipping_requests (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL,
  params          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'pending',
  outcome         text,
  outcome_detail  text,
  result          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  requested_by    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  finished_at     timestamptz,
  CONSTRAINT clipping_requests_kind_check CHECK (kind IN ('schema', 'test', 'import', 'add-properties')),
  CONSTRAINT clipping_requests_status_check CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
  CONSTRAINT clipping_requests_outcome_check CHECK (outcome IS NULL OR outcome IN (
    'ok', 'not-configured', 'unsupported-source', 'refused', 'not-shared',
    'schema-mismatch', 'rate-limited', 'unavailable', 'timeout', 'incomplete',
    'key-unreadable', 'local-error'
  )),
  -- A one-line owner sentence, never a vendor body or a token.
  CONSTRAINT clipping_requests_detail_short CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 400),
  CONSTRAINT clipping_requests_requested_by_not_empty CHECK (length(btrim(requested_by)) > 0)
);

CREATE INDEX IF NOT EXISTS clipping_requests_queue_idx
  ON clipping_requests (status, created_at);

CREATE TABLE IF NOT EXISTS clipping_choice (
  -- One row, enforced: the only legal id is true.
  id      boolean     PRIMARY KEY DEFAULT true CHECK (id),
  mode    text        NOT NULL,
  set_by  text        NOT NULL,
  set_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clipping_choice_mode_check CHECK (mode IN ('notion', 'karakeep', 'both')),
  CONSTRAINT clipping_choice_set_by_not_empty CHECK (length(btrim(set_by)) > 0)
);

COMMIT;
