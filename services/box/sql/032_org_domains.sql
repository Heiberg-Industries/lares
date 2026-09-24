-- Organisation-owned email domains are installation data, configured by its owner.
-- Routing uses this list to exclude internal mail from prospect signals.
-- A fresh schema has no assumed domains; existing configured domains are preserved.
BEGIN;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS domains text[] NOT NULL DEFAULT '{}';
COMMIT;
