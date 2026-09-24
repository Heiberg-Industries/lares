-- Shared email voice: one editable bilingual card (Core + EN + NO) + per-language model + learn
-- config, plus the learned exemplar corpus (one row per sent email, language-tagged with its
-- embedding vector). Singleton profile row id='default'. Vectors are JSON (small, single-user;
-- in-memory cosine — no pgvector).
CREATE TABLE IF NOT EXISTS voice_profile (
  id                    text        NOT NULL DEFAULT 'default',
  core                  text        NOT NULL DEFAULT '',
  english               text        NOT NULL DEFAULT '',
  norsk                 text        NOT NULL DEFAULT '',
  model_en              text,
  model_no              text,
  learn_key             text        NOT NULL DEFAULT 'saga',
  learn_lookback_days   int         NOT NULL DEFAULT 365,
  learn_cap             int         NOT NULL DEFAULT 300,
  proposed              jsonb,
  relearn_requested_at  timestamptz,
  learn_status          text        NOT NULL DEFAULT 'idle' CHECK (learn_status IN ('idle','running','error')),
  learn_message         text        NOT NULL DEFAULT '',
  updated_by            text        NOT NULL DEFAULT 'system',
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- Ensure the singleton exists so the console/runtime always read one row.
INSERT INTO voice_profile (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS voice_exemplar (
  id                 text        NOT NULL,           -- = source_message_id (dedupes re-runs)
  lang               text        NOT NULL CHECK (lang IN ('en','no')),
  text               text        NOT NULL,
  vector             jsonb       NOT NULL,           -- number[] embedding
  source_message_id  text        NOT NULL DEFAULT '',
  included           boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
