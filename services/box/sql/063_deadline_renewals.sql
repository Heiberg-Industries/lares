-- 063_deadline_renewals.sql — LAR-22-s1. Renewals (domains, certificates, subscriptions,
-- insurance) ride the existing deadline calendar and its recurrence (sql/036); what was missing
-- was who is paid and how much. Adds `vendor`, `amount` and `currency` to `deadlines`, and widens
-- the `source` list with `'renewal'`.
--
-- Numbered 063, not the next free number after 050: another workstream owns 060-062 and this
-- installation's migration runner refuses a file numbered below the highest one already applied.
--
-- `deadlines_source_check` is the name Postgres assigned the inline column CHECK in sql/036 (no
-- explicit CONSTRAINT name was given there); dropping and re-adding it under that same name is
-- how a hand-applied ALTER widens an inline CHECK without knowing its name in advance elsewhere.
--
-- Hand-applied; idempotent; one transaction. Existing rows are untouched and read back with NULLs
-- in the three new columns.
BEGIN;

ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS vendor text;
ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS amount numeric(12,2);
ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS currency text CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS deadlines_source_check;
ALTER TABLE deadlines ADD CONSTRAINT deadlines_source_check
  CHECK (source IN ('statutory','accounting','contract','subscription','manual','renewal'));

COMMIT;
