-- 084_dream_tables_owner.sql — W5I-s6 (ruling D5, WIDENED by the owner 2026-09-19).
--
-- WHAT THIS FILE IS FOR. `dream_observations` and `dream_preferences` hold a person's inferred
-- observations and standing preferences (ADR-0018) and, until now, carried no person column at
-- all — `services/box/lib/member-scope.ts` listed both on `LEGACY_COLUMNLESS_TABLES`. This file
-- gives each an `owner text` column and, ONLY where the identity register holds EXACTLY ONE
-- member, labels every row that already existed as that member's — a fact, not a guess, when
-- there is only one person it could be. With more than one member (or none at all) the existing
-- rows stay NULL: there a guess would be real, and a wrong owner on an inferred observation is
-- worse than no owner at all.
--
-- UNUSUAL SHAPE, AND WHY. Neither table is CREATEd by any `services/box/sql` migration:
-- `services/chief-of-staff/lib/dream/store.ts`'s `ensureDreamTables` creates them at runtime, the
-- first time the dream schedule (or a test) needs them. So this file does not create anything —
-- it ALTERs two tables that may or may not exist yet on the database it runs against, guarded by
-- `to_regclass` the same way box 083 guards a table it cannot assume is there. The column
-- definition here (`owner text`, nullable, no default) is byte-for-byte the same ALTER
-- `ensureDreamTables` itself runs, so the two can never disagree about the column's shape,
-- whichever happens to run first:
--   * on the one LIVE installation this file is applied to by hand, the tables already exist —
--     this file's ALTER adds the column and its labelling backfills the existing rows in the
--     same transaction;
--   * on a FRESH installation, box migrations (this one included) are applied before
--     chief-of-staff ever starts, so neither table is here yet — every guard below turns into a
--     no-op, reported as such, and `ensureDreamTables` creates the column itself (with nothing to
--     label: a freshly created table has no rows) the first time the service starts;
--   * the CI image probe (services/keeper/tests/runtime-image.probe.py) has NEITHER table nor
--     `users` (014_identity.sql is never applied there either) — both guards below turn the
--     whole thing into a no-op, reported the same way 083's does when the identity register
--     itself is missing. No prerequisite CREATE is needed in the probe: unlike 083, this file
--     ALTERs nothing that any `services/box/sql` migration creates.
--
-- `services/chief-of-staff/lib/dream/store.ts` ALSO exports `labelExistingDreamRows(db)` — the
-- exact same rule, expressed in TypeScript, for two callers this SQL file cannot reach: a deploy
-- where the column was added by `ensureDreamTables` before this file happened to be applied by
-- hand, and the erase CLI's `--prepare` path (a later slice). Running either implementation, or
-- both, in either order, ends at the same answer: every row that predates the column, and only
-- those, get exactly one owner — the register's one member, when there is exactly one; otherwise
-- nothing changes.
--
-- WHY NO DRY-RUN SELECT, UNLIKE 083. 083's rewrite has a real judgement call in it — which
-- spelling resolves to which person, and what to do with one two people claim — worth showing an
-- operator before it runs. This file's rule has none: if the register holds exactly one member,
-- every row without an owner becomes that member's; otherwise nothing is touched. There is
-- nothing to preview that the report below does not already say after the fact, in one pass.
--
-- ONE TRANSACTION, IDEMPOTENT: a second run adds no column (it is already there) and labels no
-- row (nothing is left NULL that the first run did not already decide about), and prints the
-- same shape of findings minus anything that changed the first time.

BEGIN;

CREATE TEMP TABLE migration_084_findings (
  table_name text,
  row_count  bigint,
  finding    text
) ON COMMIT DROP;

DO $migration_084$
DECLARE
  has_obs      boolean;
  has_pref     boolean;
  has_register boolean;
  member_count bigint;
  owner_id     text;
  obs_labelled bigint;
  pref_labelled bigint;
BEGIN
  has_obs  := to_regclass('dream_observations') IS NOT NULL;
  has_pref := to_regclass('dream_preferences')  IS NOT NULL;

  -- ── 1. The column, on whichever of the two tables happens to be here ──────────────────────
  IF has_obs THEN
    ALTER TABLE dream_observations ADD COLUMN IF NOT EXISTS owner text;
  ELSE
    INSERT INTO migration_084_findings (table_name, row_count, finding)
    VALUES ('dream_observations', NULL,
      'ok, skipped - this table is not in this database yet (it is created at runtime by ' ||
      'ensureDreamTables, services/chief-of-staff/lib/dream/store.ts), so there was no column ' ||
      'to add and no row to label.');
  END IF;

  IF has_pref THEN
    ALTER TABLE dream_preferences ADD COLUMN IF NOT EXISTS owner text;
  ELSE
    INSERT INTO migration_084_findings (table_name, row_count, finding)
    VALUES ('dream_preferences', NULL,
      'ok, skipped - this table is not in this database yet (it is created at runtime by ' ||
      'ensureDreamTables, services/chief-of-staff/lib/dream/store.ts), so there was no column ' ||
      'to add and no row to label.');
  END IF;

  IF NOT has_obs AND NOT has_pref THEN
    RETURN; -- neither table is here; nothing left that labelling could do
  END IF;

  -- ── 2. The label, only where the register holds exactly one member ────────────────────────
  has_register := to_regclass('users') IS NOT NULL;
  IF NOT has_register THEN
    INSERT INTO migration_084_findings (table_name, row_count, finding)
    VALUES (NULL, NULL,
      'LEFT ALONE - the identity register (users, services/box/sql/014_identity.sql) is not in ' ||
      'this database, so no existing row was labelled. The column was still added wherever the ' ||
      'table was here.');
    RETURN;
  END IF;

  -- A table-level lock, not just a row lock: it blocks a concurrent INSERT/DELETE on `users`
  -- until this transaction ends, so the count below and the UPDATEs it gates can never disagree.
  LOCK TABLE users IN EXCLUSIVE MODE;
  SELECT count(*) INTO member_count FROM users;

  IF member_count <> 1 THEN
    INSERT INTO migration_084_findings (table_name, row_count, finding)
    VALUES (NULL, member_count,
      'LEFT ALONE - the identity register holds ' || member_count || ' member(s), not exactly ' ||
      'one, so labelling an existing row would be a guess rather than a fact (ruling D5). Every ' ||
      'row already here stays NULL; only new rows carry an owner from here on.');
    RETURN;
  END IF;

  SELECT id INTO owner_id FROM users LIMIT 1;

  IF has_obs THEN
    UPDATE dream_observations SET owner = owner_id WHERE owner IS NULL;
    GET DIAGNOSTICS obs_labelled = ROW_COUNT;
    INSERT INTO migration_084_findings (table_name, row_count, finding)
    VALUES ('dream_observations', obs_labelled,
      'ok, labelled - every row that existed before this column did now carries ' || owner_id ||
      ' (the identity register''s one member).');
  END IF;

  IF has_pref THEN
    UPDATE dream_preferences SET owner = owner_id WHERE owner IS NULL;
    GET DIAGNOSTICS pref_labelled = ROW_COUNT;
    INSERT INTO migration_084_findings (table_name, row_count, finding)
    VALUES ('dream_preferences', pref_labelled,
      'ok, labelled - every row that existed before this column did now carries ' || owner_id ||
      ' (the identity register''s one member).');
  END IF;
END
$migration_084$;

-- The report. `LEFT ALONE` sorts before `ok` on purpose: the things that need a human are the
-- first thing on the screen (the same convention box 083 uses).
SELECT table_name, row_count, finding
  FROM migration_084_findings
 ORDER BY finding, table_name NULLS FIRST;

COMMIT;
