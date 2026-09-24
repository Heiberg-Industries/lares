-- Identity schema only. The installer creates the first owner explicitly.
-- Existing identities, aliases, reminder owners and OAuth principals are never rewritten.
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            text        PRIMARY KEY,              -- canonical slug, never a channel id
  display_name  text        NOT NULL,
  primary_email text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_aliases (
  system     text        NOT NULL,                    -- 'slack' | 'telegram' | 'email' | 'google' | 'legacy'
  alias      text        NOT NULL,                    -- the channel-native / historical spelling
  user_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, alias)
);
CREATE INDEX IF NOT EXISTS user_aliases_user_idx ON user_aliases (user_id);

COMMIT;
