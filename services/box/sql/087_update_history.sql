-- 087_update_history.sql — one row per update run: which image digests were running BEFORE it.
--
-- WHY THIS EXISTS. Nothing on disk records which digests were live before an update overwrites
-- the rendered compose file (`renderAgentsCompose`, services/keeper/lib/compose-agents.ts). So
-- "one command puts the previous version back" (ADR-0021 rule 4) had no data behind it — this
-- table is that data, and nothing more. It records what was running; it does not decide when to
-- roll back or how (that is `lares rollback`, a later slice, over `previousImages` below).
--
-- NO PERSON COLUMN, and none is owed. This is the installation's own update log: which images,
-- which migration, which restic snapshot, whether it finished — never a person's words or a
-- person's data. Classified `operational` in services/box/lib/member-scope.ts.
--
-- NO SECRET. `images` holds only image references (`name@sha256:<64 hex>`) and `snapshot_id` is
-- a restic snapshot id — an opaque label, not a credential. Nothing here is a compose file, an
-- env dump, or anything that could carry a secret.
--
-- `images` IS CONSTRAINED TO DIGEST REFERENCES ONLY, the same rule
-- services/keeper/lib/compose-agents.ts's `DIGEST` already enforces before it will render a
-- compose file, and the same rule services/box/lib/release-manifest.ts's `DIGEST_REFERENCE`
-- restates for the installer. A tag here would mean "what was running" is itself a guess.
--
-- WHY A HELPER FUNCTION, NOT A BARE CHECK EXPRESSION. Postgres refuses a CHECK constraint whose
-- own expression contains a subquery ("cannot use subquery in check constraint") — checking
-- "every value in this jsonb object matches a pattern" needs `jsonb_each_text`, which is exactly
-- that. An IMMUTABLE SQL function is opaque to that restriction: the constraint calls it as a
-- plain scalar expression, and the subquery lives inside the function body instead.
--
-- `outcome` HAS FOUR STATES, not two: `started` (a run began but has not been closed — a crash
-- mid-update leaves exactly this), `ok`, `failed`, `rolled-back`. `previousImages` (the lib
-- module beside this file) only ever reads the newest `ok` row: a `started` or `failed` row must
-- never be mistaken for "what was last known good".
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS update_history (
  id            bigserial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  from_release  text,
  to_release    text NOT NULL CHECK (to_release <> ''),
  images        jsonb NOT NULL,
  snapshot_id   text,
  outcome       text NOT NULL DEFAULT 'started'
                CHECK (outcome IN ('started','ok','failed','rolled-back')),
  detail        text CHECK (detail IS NULL OR length(detail) <= 400)
);

-- Every value in `images` is a full digest reference: the same rule
-- services/keeper/lib/compose-agents.ts enforces before it will render a compose file.
CREATE OR REPLACE FUNCTION update_history_images_are_digests(images jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(images) = 'object' AND images <> '{}'::jsonb AND NOT EXISTS (
    SELECT 1 FROM jsonb_each_text(images) AS e(k, v)
    WHERE v !~ '^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$')
$$;
ALTER TABLE update_history DROP CONSTRAINT IF EXISTS update_history_images_are_digests;
ALTER TABLE update_history ADD CONSTRAINT update_history_images_are_digests
  CHECK (update_history_images_are_digests(images));

CREATE INDEX IF NOT EXISTS update_history_started_idx ON update_history (started_at DESC);

COMMIT;
