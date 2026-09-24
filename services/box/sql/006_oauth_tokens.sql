-- 006_oauth_tokens.sql
-- Per-principal encrypted OAuth refresh tokens (Gmail first). One row per (principal, provider).
-- The refresh token is AES-256-GCM encrypted (lib/crypto.ts); the key lives in TOKEN_ENC_KEY, never here.
CREATE TABLE oauth_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal          text        NOT NULL,                 -- per-user attribution (ADR-0009)
  provider           text        NOT NULL,                 -- 'google'
  org_id             text        NOT NULL,                 -- Workspace org (picks the per-org client-id)
  email_address      text        NOT NULL,                 -- the mailbox this token acts as
  refresh_token_enc  text        NOT NULL,                 -- base64(IV||ct||tag)
  scopes             text[]      NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_tokens_principal_provider_uk UNIQUE (principal, provider)
);
CREATE INDEX oauth_tokens_provider_idx ON oauth_tokens (provider);
