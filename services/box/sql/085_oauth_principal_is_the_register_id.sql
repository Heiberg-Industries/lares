-- 085_oauth_principal_is_the_register_id.sql — W5I-s8, owner ruling D4 (REVERSED: rename now,
-- do not freeze). `oauth_tokens.principal` and `email_watch_cursors.principal` hold the identity
-- register's id, the same one every other person column has held since 083.
--
-- WHAT THIS FILE IS FOR. These two tables name a person with a `principal` — a door-native or
-- historical spelling that predates the register (`users` / `user_aliases`, 014_identity.sql).
-- Everything else about a person now answers to the register's id; these two did not, so an
-- erase, an export or a "which accounts does this person have" question had to know a second id
-- space and every spelling in it. This file moves each value that the register resolves to
-- exactly one person onto that person's canonical id, and leaves — and reports — everything
-- else. 014_identity.sql's own note that `oauth_tokens.principal` is "deliberately NOT
-- rewritten" is superseded by this file; that file is left byte-for-byte as it was, because its
-- checksum is recorded in `schema_migrations` on every box that has applied it.
--
-- SAFE BECAUSE THE PRINCIPAL IS A LOOKUP KEY, NOT KEY MATERIAL. This is the finding the owner's
-- ruling rests on, and it is checkable in four lines of code:
--   * `services/box/lib/crypto.ts` encrypts with `aes-256-gcm`; the key is `keyBuf(keyHex)` —
--     `TOKEN_ENC_KEY` used DIRECTLY. No key derivation, no salt, no per-row key.
--   * the nonce is `randomBytes(12)` and is stored inside the blob
--     (`base64(IV || ciphertext || authTag)`), so a decrypt needs the blob and the env key and
--     nothing else.
--   * `setAAD` is called NOWHERE in this repository, so the principal is not bound into the
--     ciphertext as additional authenticated data.
--   * `principal` appears only in `WHERE principal=$1` (services/box/lib/oauth-tokens.ts,
--     packages/agent-kit/src/google-auth.ts) and in the uniqueness key
--     `(principal, provider, email_address)` (010_oauth_tokens_multi_account.sql).
-- So renaming the value CANNOT make a token undecryptable and nobody has to consent again.
-- `services/box/tests/oauth-principal-rename.test.ts` proves it the only way worth trusting: it
-- stores a real encrypted token under the old spelling, applies this file, asserts the stored
-- ciphertext bytes are unchanged, and decrypts the token under the NEW principal with the same
-- key.
--
-- THE RULE IT NEVER BREAKS: NO TOKEN IS EVER LOST.
--   * A value is renamed only when exactly ONE person in the register answers to it — the rule
--     `services/box/lib/person-identity.ts`'s `resolvePerson` applies, written here as SQL. A
--     value nobody answers to, and a value two people claim, is left exactly as it is and
--     REPORTED in the result set this file ends with.
--   * A rename that would COLLIDE with a row the canonical id already has for the same
--     provider/mailbox (oauth_tokens) or the same watcher/mailbox (email_watch_cursors) is NOT
--     done. That one row is left, reported by name and count, and every other row still moves.
--     Deciding which of two rows for the same mailbox survives is a judgement about the owner's
--     Google access, not something a migration may make.
--   * Nothing is deleted, nothing is inserted, no ciphertext byte is touched.
--
-- ON A NEW INSTALLATION THIS IS A NO-OP. A box that never had a legacy spelling has principals
-- that already equal the register's id, so every value reports "no change".
--
-- APPLIED BY HAND over SSH, and possibly twice (the box has no auto-migrate). ONE TRANSACTION,
-- idempotent: a second run resolves every value to itself and changes no row.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- FIRST, A DRY RUN. Paste the SELECT between the two markers below into psql on the box and
-- read its output aloud before applying anything. It writes nothing. It lists every distinct
-- principal in both tables, how many rows carry it, and what this file would do with it. A
-- `LEFT ALONE` line is a person the register has never been told about, a spelling two people
-- claim, or a row that would collide — none of those will be touched.
-- (`services/box/tests/oauth-principal-rename.test.ts` greps this SELECT out of this file and
-- runs it, so it cannot drift away from the migration below it.)
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
--   rows_now AS (
--     SELECT 'oauth_tokens' AS table_name, t.principal AS value,
--            EXISTS (SELECT 1 FROM resolved r2 JOIN oauth_tokens x ON x.principal = r2.person
--                     WHERE r2.spelling = t.principal
--                       AND x.provider = t.provider AND x.email_address = t.email_address) AS collides
--       FROM oauth_tokens t
--     UNION ALL
--     SELECT 'email_watch_cursors', t.principal,
--            EXISTS (SELECT 1 FROM resolved r2 JOIN email_watch_cursors x ON x.principal = r2.person
--                     WHERE r2.spelling = t.principal
--                       AND x.watcher = t.watcher AND x.email_address = t.email_address)
--       FROM email_watch_cursors t
--   ),
--   grouped AS (
--     SELECT table_name, value, collides, count(*) AS row_count
--       FROM rows_now GROUP BY table_name, value, collides
--   )
-- SELECT g.table_name,
--        g.value,
--        g.row_count,
--        CASE WHEN r.person IS NULL   THEN 'LEFT ALONE - the register does not resolve this to exactly one person'
--             WHEN r.person = g.value THEN 'no change - already the register id'
--             WHEN g.collides         THEN 'LEFT ALONE - ' || r.person || ' already has a row for this mailbox'
--             ELSE 'WOULD BECOME ' || r.person END AS what_085_would_do
--   FROM grouped g
--   LEFT JOIN resolved r ON r.spelling = g.value
--  ORDER BY 1, 2;
-- DRY RUN SELECT — END
--
-- The dry run reads `users` and `user_aliases`; on a box without 014_identity.sql it errors
-- rather than answering, which is the honest result — there is no register to resolve against,
-- and this file would rename nothing there either.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- AND IF IT HAS TO GO BACK. This rename is NOT reversible by guesswork — the old spelling is
-- gone from the row the moment it is renamed. It is reversible BY RECORD: the `user_aliases`
-- rows that carry the old spellings are deliberately NOT removed by this file. They are what
-- the resolver uses to find a row this migration missed, and what the statements below read to
-- put the old spelling back. The pair between the markers restores, per person, the ONE alias
-- registered under the named system — `'google'`, the system 014_identity.sql registers an
-- enrolment spelling under. Two things to check before pasting it:
--   * if the spelling a reader actually used lives under a different alias system (a
--     case-divergent watcher spelling is usually registered under `'legacy'`), change the two
--     `system = 'google'` lines to that system, or run the pair once per system;
--   * a person with SEVERAL aliases in the named system is skipped entirely rather than being
--     given an arbitrary one of them — for those, name the alias literally:
--       UPDATE oauth_tokens SET principal = '<the old spelling>' WHERE principal = '<the register id>';
-- The same no-collision rule applies backwards, so a restore can never overwrite a row either.
--
-- ROLLBACK — BEGIN
-- BEGIN;
-- WITH one_alias AS (
--   SELECT user_id, min(alias) AS alias FROM user_aliases
--    WHERE system = 'google' GROUP BY user_id HAVING count(*) = 1
-- )
-- UPDATE oauth_tokens t
--    SET principal = a.alias
--   FROM one_alias a
--  WHERE t.principal = a.user_id
--    AND NOT EXISTS (SELECT 1 FROM oauth_tokens x
--                     WHERE x.principal = a.alias AND x.provider = t.provider
--                       AND x.email_address = t.email_address);
-- WITH one_alias AS (
--   SELECT user_id, min(alias) AS alias FROM user_aliases
--    WHERE system = 'google' GROUP BY user_id HAVING count(*) = 1
-- )
-- UPDATE email_watch_cursors t
--    SET principal = a.alias
--   FROM one_alias a
--  WHERE t.principal = a.user_id
--    AND NOT EXISTS (SELECT 1 FROM email_watch_cursors x
--                     WHERE x.principal = a.alias AND x.watcher = t.watcher
--                       AND x.email_address = t.email_address);
-- COMMIT;
-- ROLLBACK — END
--
-- FOUR READERS SUPPLY THE OLD STRING, AND THEY CHANGE IN THE SAME MAINTENANCE WINDOW. Applying
-- this file alone, without moving the three environment values with it, leaves each reader
-- looking under a spelling no row has any more — and a token lookup that finds nothing reads as
-- "no account connected", not as an error. See `docs/runbooks/2026-09-19-oauth-principal-rename.md`
-- for the order. The engine now says so once, loudly, in the log when a lookup finds no token:
-- `services/box/lib/oauth-tokens.ts` and `packages/agent-kit/src/google-auth.ts`.
--
-- EVERY STATEMENT IS GUARDED BY `to_regclass`. A box without one of these tables, or without the
-- register, gets a no-op and a line in the report rather than an error. That is not only
-- tidiness: the CI image probe (`services/keeper/tests/runtime-image.probe.py`) builds a
-- database from 039 upward plus a handful of older files, and it has NEITHER of these tables
-- (006, 012) NOR the register (014) — so on the probe this file does nothing at all, and the
-- fixture test is the real proof.
--
-- WHAT IT ALTERS, AND WHICH FILE CREATES IT:
--   oauth_tokens          006_oauth_tokens.sql (uniqueness key replaced by
--                         010_oauth_tokens_multi_account.sql)
--   email_watch_cursors   012_email_watch_cursors.sql
-- It reads `users` and `user_aliases` (014_identity.sql) and writes neither.

BEGIN;

-- The report, as a RESULT SET rather than RAISE NOTICE, so a script, a test and a human reading
-- psql all see the same thing. It disappears when the transaction commits.
CREATE TEMP TABLE migration_085_findings (
  table_name  text,
  column_name text,
  value       text,
  row_count   bigint,
  finding     text
) ON COMMIT DROP;

DO $migration_085$
DECLARE
  spec         text;
  tbl          text;
  col          text;
  keycol       text;
  key_pred     text;
  changed      bigint;
  has_register boolean;
BEGIN
  has_register := to_regclass('users') IS NOT NULL AND to_regclass('user_aliases') IS NOT NULL;

  IF NOT has_register THEN
    INSERT INTO migration_085_findings (table_name, column_name, value, row_count, finding)
    VALUES (NULL, NULL, NULL, NULL,
      'LEFT ALONE - the identity register (users / user_aliases, services/box/sql/014_identity.sql) '
      'is not in this database, so no principal was read, resolved or renamed.');
    RAISE NOTICE '085: no identity register in this database - no principal was renamed.';
  END IF;

  -- table : column : the other columns its uniqueness key is made of. A rename that would make
  -- two rows equal on THAT key is the one case this file refuses, per row.
  FOREACH spec IN ARRAY ARRAY[
    'oauth_tokens:principal:provider,email_address',
    'email_watch_cursors:principal:watcher,email_address'
  ] LOOP
    tbl := split_part(spec, ':', 1);
    col := split_part(spec, ':', 2);

    IF to_regclass(tbl) IS NULL THEN
      INSERT INTO migration_085_findings (table_name, column_name, value, row_count, finding)
      VALUES (tbl, col, NULL, NULL,
        'ok, skipped - this table is not in this database, so there was nothing to change');
      CONTINUE;
    END IF;

    -- ` AND x.<k> = t.<k>` for each key column, built from quoted identifiers.
    key_pred := '';
    FOREACH keycol IN ARRAY string_to_array(split_part(spec, ':', 3), ',') LOOP
      key_pred := key_pred || format(' AND x.%1$I = t.%1$I', keycol);
    END LOOP;

    IF has_register THEN
      -- ── 1. Rename what exactly one person in the register answers to ──────────────────────
      --
      -- `resolved` is `resolvePerson`'s rule as SQL: a spelling counts only when the canonical
      -- ids that answer to it — the id itself, and the user_id of every alias row carrying it
      -- whose person really is in `users` — are all the same one person. A spelling two people
      -- claim, or one whose alias points at a person the register no longer holds, never reaches
      -- this UPDATE.
      --
      -- The `NOT EXISTS` is the no-token-is-ever-lost rule, applied PER ROW rather than per
      -- table: a row whose new name is already taken for the same mailbox stays exactly as it
      -- is, and its neighbours still move. The inner block's implicit savepoint is the backstop
      -- for anything the predicate did not foresee — that table is then left whole and reported,
      -- and the other one still goes through.
      BEGIN
        EXECUTE format($rename$
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
             AND NOT EXISTS (SELECT 1 FROM %1$I x WHERE x.%2$I = r.person %3$s)
        $rename$, tbl, col, key_pred);
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed > 0 THEN
          INSERT INTO migration_085_findings (table_name, column_name, value, row_count, finding)
          VALUES (tbl, col, NULL, changed,
            'ok, renamed - rows whose principal was a known spelling of one register person now '
            'hold that person''s id. No ciphertext was touched.');
          RAISE NOTICE '085: % rows renamed in %.%', changed, tbl, col;
        END IF;
      EXCEPTION WHEN unique_violation THEN
        INSERT INTO migration_085_findings (table_name, column_name, value, row_count, finding)
        VALUES (tbl, col, NULL, NULL,
          'LEFT ALONE - renaming this table would have made two rows identical on the key it is '
          'unique on, so NOTHING in it was changed and nothing was deleted. Decide by hand which '
          'row survives, remove the other, then run this file again.');
        RAISE NOTICE '085: % left untouched - a rename would duplicate an existing row.', tbl;
      END;

      -- ── 2. Report every principal that is still not this person's register id ─────────────
      --
      -- After step 1 a value that the register DOES resolve to a different person can only be a
      -- row whose rename would have collided (or a table step 1 abandoned whole). Both are named
      -- here with their row count, so nobody has to go looking.
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
                   WHEN r.person IS NOT NULL
                     THEN 'LEFT ALONE - renaming this would collide with a row ' || r.person ||
                          ' already has for the same mailbox, so nothing here was renamed and '
                          'nothing was deleted. Decide by hand which row survives, remove the '
                          'other, then run this file again'
                   WHEN EXISTS (SELECT 1 FROM register g WHERE g.spelling = v.value)
                     THEN 'LEFT ALONE - more than one person in the identity register claims this '
                          'value, so nothing here was renamed and nobody guessed which was meant'
                   ELSE 'LEFT ALONE - nobody in the identity register answers to this value. It '
                        'may be a person the register has never been told about, a service '
                        'account, or a typo. Add it as an alias of the person it belongs to and '
                        'run this file again, or leave it: nothing was changed and nothing was '
                        'deleted'
                 END AS finding
            FROM vals v
            LEFT JOIN resolved r ON r.spelling = v.value
        )
        INSERT INTO migration_085_findings (table_name, column_name, value, row_count, finding)
        SELECT %1$L, %2$L, j.value, j.row_count, j.finding FROM judged j WHERE j.finding IS NOT NULL
      $report$, tbl, col);
    END IF;
  END LOOP;
END
$migration_085$;

-- `LEFT ALONE` sorts before `ok` on purpose: the things that need a human are the first thing on
-- the screen.
SELECT table_name, column_name, value, row_count, finding
  FROM migration_085_findings
 ORDER BY finding, table_name NULLS FIRST, value NULLS FIRST;

COMMIT;
