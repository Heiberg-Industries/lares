-- Dream observation and preference tables. The schema belongs to offline migrations so
-- application logins need only read/write privileges.
BEGIN;

CREATE TABLE IF NOT EXISTS dream_observations (
  id         uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  text       text             NOT NULL,
  kind       text             NOT NULL,
  subject    text             NOT NULL DEFAULT '',
  confidence double precision NOT NULL DEFAULT 0,
  source     text,
  owner      text,
  valid_from timestamptz      NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  created_at timestamptz      NOT NULL DEFAULT now()
);

-- Existing rows retain a NULL normalized value, get the existing 'agent' backfill, and never
-- receive an inferred owner.
ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS text_norm text;
ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent';
ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS owner text;

CREATE TABLE IF NOT EXISTS dream_preferences (
  id            uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  text          text             NOT NULL,
  kind          text             NOT NULL,
  subject       text             NOT NULL DEFAULT '',
  confidence    double precision NOT NULL DEFAULT 0,
  source        text,
  owner         text,
  valid_from    timestamptz      NOT NULL DEFAULT now(),
  valid_to      timestamptz,
  superseded_by uuid,
  created_at    timestamptz      NOT NULL DEFAULT now()
);

ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent';
ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS owner text;

COMMIT;
