-- ADR-0009: audit attributes every action/approval to a specific internal user.
-- Nullable so existing single-principal agents (Saga) are unaffected.
ALTER TABLE audit ADD COLUMN IF NOT EXISTS principal text;
