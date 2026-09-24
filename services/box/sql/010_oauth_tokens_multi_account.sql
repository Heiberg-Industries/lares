-- 010_oauth_tokens_multi_account.sql
-- Relax oauth_tokens uniqueness so one principal can hold several Google accounts
-- (e.g. owner@owner.example AND owner@project.example). Keyed now by the mailbox address.
-- Applied BY HAND on the box (no auto-migrate). Idempotent-safe to re-run.
ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_principal_provider_uk;
ALTER TABLE oauth_tokens
  ADD CONSTRAINT oauth_tokens_principal_provider_email_uk
  UNIQUE (principal, provider, email_address);
