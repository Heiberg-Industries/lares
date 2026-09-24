-- 083_owner_key_is_the_register_id.sql — W5I-s4. The free-text `owner` columns hold the
-- identity register's id, and from now on they cannot hold an empty one.
--
-- WHAT THIS FILE IS FOR. Sixteen tables name a person in a plain `owner` (or `user_id`) text
-- column that nothing checks: convention fills it with the register's canonical id, but an older
-- row may carry a legacy or channel-native spelling instead, and the database is equally happy
-- with a typo. An erase, an export or a forget that matches one spelling silently misses the
-- rows written under another and reports success. This file moves every value that the identity
-- register (`users` / `user_aliases`, 014_identity.sql) can resolve onto that person's canonical
-- id, so that one match finds all of their rows.
--
-- THE RULE IT NEVER BREAKS: NOTHING IS ORPHANED. A value is rewritten only when exactly ONE
-- person in the register answers to it — the same test `services/box/lib/person-identity.ts`'s
-- `resolvePerson` applies. A value nobody answers to, and a value two people claim, is left
-- exactly as it is and REPORTED by name, table and row count in the result set this file ends
-- with. Nothing is deleted, nothing is guessed at, and no row is left pointing at a person who
-- is not in the register.
--
-- APPLIED BY HAND over SSH, and possibly twice (the box has no auto-migrate). ONE TRANSACTION,
-- idempotent: a second run resolves every value to itself, changes no row, adds no constraint
-- twice, and prints the same findings minus the "rewritten" lines. The 014 pattern.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- FIRST, A DRY RUN. Paste the SELECT between the two markers below into psql on the box. It
-- writes nothing. It lists every distinct owner value in the fifteen tables this file rewrites,
-- how many rows carry it, and what would happen to it. Read the `LEFT ALONE` lines before you
-- apply anything: each one is a person the register has never heard of, or a spelling two people
-- claim, and this file will not touch it.
-- (`services/box/tests/owner-key-normalised.test.ts` greps this SELECT out of this file and runs
-- it, so it cannot drift away from the migration below it.)
--
-- DRY RUN SELECT — BEGIN
-- WITH register AS (
--     SELECT u.id AS spelling, u.id AS person FROM users u
--     UNION ALL
--     SELECT a.alias, a.user_id FROM user_aliases a JOIN users u ON u.id = a.user_id
--   ),
--   resolved AS (
--     SELECT spelling, min(person) AS person
--       FROM register GROUP BY spelling HAVING count(DISTINCT person) = 1
--   ),
--   owner_values (table_name, value, row_count) AS (
--               SELECT 'reminders',              owner,   count(*) FROM reminders              WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'proactivity_settings',   owner,   count(*) FROM proactivity_settings   WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'initiations',            owner,   count(*) FROM initiations            WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'owner_clock_signals',    owner,   count(*) FROM owner_clock_signals    WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'deadlines',              owner,   count(*) FROM deadlines              WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'deadline_candidates',    owner,   count(*) FROM deadline_candidates    WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'deadline_settings',      owner,   count(*) FROM deadline_settings      WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'markets_settings',       owner,   count(*) FROM markets_settings       WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'brief_settings',         owner,   count(*) FROM brief_settings         WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'conversation_retention', owner,   count(*) FROM conversation_retention WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'schedule_settings',      owner,   count(*) FROM schedule_settings      WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'agent_notes',            owner,   count(*) FROM agent_notes            WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'memory_use',             owner,   count(*) FROM memory_use             WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'memory_reads',           owner,   count(*) FROM memory_reads           WHERE owner   IS NOT NULL GROUP BY owner
--     UNION ALL SELECT 'standing_facts',         user_id, count(*) FROM standing_facts         WHERE user_id IS NOT NULL GROUP BY user_id
--   )
-- SELECT v.table_name,
--        v.value,
--        v.row_count,
--        CASE WHEN r.person IS NULL           THEN 'LEFT ALONE - the register does not resolve this to exactly one person'
--             WHEN r.person = v.value         THEN 'no change - already the register id'
--             ELSE 'WOULD BECOME ' || r.person END AS what_083_would_do
--   FROM owner_values v
--   LEFT JOIN resolved r ON r.spelling = v.value
--  ORDER BY 1, 2;
-- DRY RUN SELECT — END
--
-- The dry run reads `users` and `user_aliases`; on a box without 014_identity.sql it errors
-- rather than answering, which is the honest result — there is no register to resolve against,
-- and this file would rewrite nothing there either.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- `forget_ledger` IS DELIBERATELY NOT REWRITTEN, AND THIS IS THE ONE THING NOT TO "FIX" LATER.
-- Its `match_hash` is derived from the owner string itself — `forgetKey(owner, kind, normalised)`
-- in `packages/vault-format/src/forget-ledger.ts` length-prefixes and hashes the three fields
-- together. The forgotten WORDS are not stored anywhere, by design, so a hash can never be
-- re-derived once the owner string changes. Rewriting `forget_ledger.owner` would therefore turn
-- every existing forget into a row that matches nothing, silently, and the owner would find
-- things they asked to be forgotten coming back. It keeps its legacy spelling, stays on the
-- inventory's `LEGACY_OWNER_KEY_TABLES`, and W5I-s7 keys NEW ledger rows on the register's id
-- instead. Its values are still REPORTED below, so nobody has to rediscover this.
--
-- NO FOREIGN KEY, AND THE CHECK IS ADDED `NOT VALID` FIRST. Two deliberate choices:
--   * No `REFERENCES users(id)`. Several of these tables legitimately hold settings rows written
--     before anyone was in the register, and an ON DELETE rule would quietly redefine what an
--     erase means without anyone deciding that (ruling D7: erase is a CLI, not a cascade).
--   * The only rule added is `CHECK (<column> <> '')` — an owner column may not be the empty
--     string. It is added `NOT VALID` and validated in a SEPARATE, separately-guarded step, so a
--     single pre-existing empty value cannot fail the whole migration: the rule takes effect for
--     every new and changed row immediately, the validation of the old rows is reported as not
--     done, and the transaction still commits.
--
-- EVERY STATEMENT IS GUARDED BY `to_regclass`, table by table. A box that has not applied
-- 001_init.sql, or keeps `standing_facts` in another database, or has not applied
-- 014_identity.sql at all, gets a no-op and a line in the report rather than an error. That is
-- not only tidiness: the CI image probe (`services/keeper/tests/runtime-image.probe.py`) builds a
-- database from 039 upward plus a handful of older files, and it has neither `reminders` (001)
-- nor the register (014).
--
-- WHAT IT ALTERS, AND WHICH FILE CREATES IT:
--   reminders              001_init.sql                 initiations            035_proactivity.sql
--   proactivity_settings   035_proactivity.sql          owner_clock_signals    035_proactivity.sql
--   deadlines              036_deadlines.sql            deadline_candidates    036_deadlines.sql
--   deadline_settings      036_deadlines.sql            markets_settings       036_deadlines.sql
--   brief_settings         050_brief_settings.sql       conversation_retention 061_conversation_retention.sql
--   schedule_settings      065_schedule_settings.sql    agent_notes            071_agent_notes.sql
--   memory_use             073_memory_use.sql           memory_reads           075_memory_reads.sql
--   forget_ledger          076_forget_ledger.sql        (constraint only — see above)
--   standing_facts         services/chief-of-staff/sql/002-standing-facts.sql (+003 adds the
--                          column) — the same database as the box tables on a normal
--                          installation (`DATABASE_URL`), skipped with a line in the report if it
--                          is not in this one.
-- It reads `users` and `user_aliases` (014_identity.sql) and writes neither.

BEGIN;

-- The report. A temporary table rather than RAISE NOTICE, so the findings come back as a RESULT
-- SET that a script, a test or a human reading psql all see the same way. It disappears when the
-- transaction commits.
CREATE TEMP TABLE migration_083_findings (
  table_name  text,
  column_name text,
  value       text,
  row_count   bigint,
  finding     text
) ON COMMIT DROP;

DO $migration_083$
DECLARE
  spec          text;
  tbl           text;
  col           text;
  mode          text;
  cons          text;
  not_rewritten text;
  changed       bigint;
  has_register  boolean;
BEGIN
  has_register := to_regclass('users') IS NOT NULL AND to_regclass('user_aliases') IS NOT NULL;

  IF NOT has_register THEN
    INSERT INTO migration_083_findings (table_name, column_name, value, row_count, finding)
    VALUES (NULL, NULL, NULL, NULL,
      'LEFT ALONE - the identity register (users / user_aliases, services/box/sql/014_identity.sql) '
      'is not in this database, so no owner value was read, resolved or rewritten. The non-empty '
      'rule was still added to every table that is here.');
    RAISE NOTICE '083: no identity register in this database - no owner value was rewritten.';
  END IF;

  -- table : column : what to do with it.
  FOREACH spec IN ARRAY ARRAY[
    'reminders:owner:rewrite',
    'proactivity_settings:owner:rewrite',
    'initiations:owner:rewrite',
    'owner_clock_signals:owner:rewrite',
    'deadlines:owner:rewrite',
    'deadline_candidates:owner:rewrite',
    'deadline_settings:owner:rewrite',
    'markets_settings:owner:rewrite',
    'brief_settings:owner:rewrite',
    'conversation_retention:owner:rewrite',
    'schedule_settings:owner:rewrite',
    'agent_notes:owner:rewrite',
    'memory_use:owner:rewrite',
    'memory_reads:owner:rewrite',
    'standing_facts:user_id:rewrite',
    'forget_ledger:owner:keep'          -- the hash was derived from this string; see the header
  ] LOOP
    tbl  := split_part(spec, ':', 1);
    col  := split_part(spec, ':', 2);
    mode := split_part(spec, ':', 3);

    IF to_regclass(tbl) IS NULL THEN
      INSERT INTO migration_083_findings (table_name, column_name, value, row_count, finding)
      VALUES (tbl, col, NULL, NULL,
        'ok, skipped - this table is not in this database, so there was nothing to change');
      CONTINUE;
    END IF;

    -- ── 1. Rewrite what exactly one person in the register answers to ───────────────────────
    --
    -- `resolved` is `resolvePerson`'s rule written as SQL: a spelling counts only when the
    -- canonical ids that answer to it — the id itself, and the user_id of every alias row
    -- carrying it whose person really is in `users` — are all the same one person. A spelling
    -- two people claim, or one whose alias points at a person the register no longer holds,
    -- never reaches this UPDATE.
    --
    -- The inner block exists for its implicit savepoint. Nine of these tables are unique on the
    -- owner column (a settings row per person, a primary key per (owner, …)), so a box that
    -- somehow holds the same person's settings under two spellings would make the rewrite a
    -- duplicate-key error. Deciding which of those two rows survives is a judgement about the
    -- owner's data, not something a migration may make: that one table is left entirely
    -- untouched, the reason is reported, and the other fifteen still go through.
    IF has_register AND mode = 'rewrite' THEN
      BEGIN
        EXECUTE format($rewrite$
          WITH register AS (
            SELECT u.id AS spelling, u.id AS person FROM users u
            UNION ALL
            SELECT a.alias, a.user_id FROM user_aliases a JOIN users u ON u.id = a.user_id
          ),
          resolved AS (
            SELECT spelling, min(person) AS person
              FROM register GROUP BY spelling HAVING count(DISTINCT person) = 1
          )
          UPDATE %1$I t
             SET %2$I = r.person
            FROM resolved r
           WHERE t.%2$I = r.spelling
             AND t.%2$I <> r.person
        $rewrite$, tbl, col);
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed > 0 THEN
          INSERT INTO migration_083_findings (table_name, column_name, value, row_count, finding)
          VALUES (tbl, col, NULL, changed,
            'ok, rewritten - rows whose value was a known spelling of one register person now '
            'hold that person''s id');
          RAISE NOTICE '083: % rows rewritten in %.%', changed, tbl, col;
        END IF;
      EXCEPTION WHEN unique_violation THEN
        INSERT INTO migration_083_findings (table_name, column_name, value, row_count, finding)
        VALUES (tbl, col, NULL, NULL,
          'LEFT ALONE - rewriting this table would have made two rows identical on a key it is '
          'unique on, so NOTHING in it was changed. The same person almost certainly has two rows '
          'here under two spellings: decide by hand which one survives, delete the other, then '
          'run this file again.');
        RAISE NOTICE '083: % left untouched - a rewrite would duplicate an existing row.', tbl;
      END;
    END IF;

    -- ── 2. Report every value that is still not this person's register id ───────────────────
    IF has_register THEN
      not_rewritten := CASE
        WHEN mode = 'keep' THEN
          'LEFT ALONE ON PURPOSE - forget_ledger.match_hash was derived from this exact string '
          'and can never be re-derived (the forgotten words are not stored). Rewriting it would '
          'switch off every forget it holds. In the register this person is '
        ELSE
          'LEFT ALONE - the register resolves this to a person, but the rewrite above did not '
          'run or did not finish for this table. In the register this person is '
      END;

      EXECUTE format($report$
        WITH register AS (
          SELECT u.id AS spelling, u.id AS person FROM users u
          UNION ALL
          SELECT a.alias, a.user_id FROM user_aliases a JOIN users u ON u.id = a.user_id
        ),
        resolved AS (
          SELECT spelling, min(person) AS person
            FROM register GROUP BY spelling HAVING count(DISTINCT person) = 1
        ),
        vals AS (
          SELECT t.%2$I AS value, count(*) AS row_count FROM %1$I t WHERE t.%2$I IS NOT NULL GROUP BY 1
        ),
        judged AS (
          SELECT v.value,
                 v.row_count,
                 CASE
                   WHEN r.person IS NOT NULL AND r.person = v.value THEN NULL
                   WHEN r.person IS NOT NULL THEN %3$L || r.person
                   WHEN EXISTS (SELECT 1 FROM register g WHERE g.spelling = v.value)
                     THEN 'LEFT ALONE - more than one person in the identity register claims this '
                          'value, so nothing here was rewritten and nobody guessed which was meant'
                   ELSE 'LEFT ALONE - nobody in the identity register answers to this value. It '
                        'may be a person the register has never been told about, a channel id, or '
                        'a typo. Add it as an alias of the person it belongs to and run this file '
                        'again, or leave it: nothing was changed and nothing was deleted'
                 END AS finding
            FROM vals v
            LEFT JOIN resolved r ON r.spelling = v.value
        )
        INSERT INTO migration_083_findings (table_name, column_name, value, row_count, finding)
        SELECT %1$L, %2$L, j.value, j.row_count, j.finding FROM judged j WHERE j.finding IS NOT NULL
      $report$, tbl, col, not_rewritten);
    END IF;

    -- ── 3. An owner column may not be the empty string ──────────────────────────────────────
    --
    -- NOT VALID, then a separate VALIDATE. The rule binds every new and changed row the moment
    -- it is added; validating the rows that were already there is a second step that is allowed
    -- to fail on its own without taking the migration with it. Both steps are wrapped so a
    -- re-run is a no-op rather than an error (the 028 pattern).
    cons := tbl || '_' || col || '_not_empty';
    BEGIN
      EXECUTE format('ALTER TABLE %1$I ADD CONSTRAINT %2$I CHECK (%3$I <> %4$L) NOT VALID',
                     tbl, cons, col, '');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %1$I VALIDATE CONSTRAINT %2$I', tbl, cons);
    EXCEPTION WHEN check_violation THEN
      INSERT INTO migration_083_findings (table_name, column_name, value, row_count, finding)
      VALUES (tbl, col, '', NULL,
        'LEFT ALONE - at least one row here has an EMPTY owner value. The non-empty rule is in '
        'place for every new and changed row, but the existing rows could not be validated '
        'against it. Find those rows, give them an owner or delete them, then run this file '
        'again to finish the validation.');
      RAISE NOTICE '083: %.% has an empty value; its non-empty rule is in place but not validated.',
                   tbl, col;
    END;
  END LOOP;
END
$migration_083$;

-- The report. `LEFT ALONE` sorts before `ok` on purpose: the things that need a human are the
-- first thing on the screen.
SELECT table_name, column_name, value, row_count, finding
  FROM migration_083_findings
 ORDER BY finding, table_name NULLS FIRST, value NULLS FIRST;

COMMIT;
