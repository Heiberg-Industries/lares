-- 062_schema_migrations.sql — the migration runner's ledger (ADR-0021 rule 3).
--
-- WHY A LEDGER AT ALL. services/box/migrate.ts re-ran every file on every invocation, and the
-- only thing that made that safe was every migration being hand-written to be re-runnable. That
-- held while one person wrote all of them. From the first public release (ADR-0021 rule 1) it
-- stops holding, so what ran is recorded rather than assumed.
--
-- THE PRIMARY KEY IS THE FILENAME, NOT THE NUMBER. services/box/sql/ has two files numbered 019
-- (019_atlas_sync.sql and 019_obligations.sql) and no 047 at all. A ledger keyed on the number
-- could not record today's tree. `number` is kept as a column for ordering and for the
-- out-of-order rule, and is deliberately NOT unique.
--
-- `checksum` is the sha256 of the file's exact bytes. A file that changed after it was applied
-- is a refusal, not a re-run: re-running it might be harmless or might not, and the runner is
-- not in a position to know which.
--
-- Applied by the runner itself before anything else (ensureLedger), and safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  number     integer     NOT NULL,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  how        text        NOT NULL,
  took_ms    integer     NOT NULL DEFAULT 0,
  -- Monotonic insert order, so two files applied in the same millisecond still read back in the
  -- order they ran. `applied_at` alone is not enough: an adoption writes a whole tree at once.
  seq        bigserial   NOT NULL,
  CONSTRAINT schema_migrations_how_check CHECK (how IN ('applied', 'adopted'))
);

CREATE INDEX IF NOT EXISTS schema_migrations_seq_idx ON schema_migrations (seq);

COMMIT;
