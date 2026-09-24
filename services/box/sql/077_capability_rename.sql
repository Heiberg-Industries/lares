-- 077_capability_rename.sql — the capability strings this box already recorded (ADR-0017 rule 1:
-- one `vault` capability replaces `brain`, `atlas` and `memory`).
--
-- WHY A MIGRATION AT ALL. `ratchet` and `approval_events` are keyed on (agent, capability, action)
-- (packages/agent-kit/src/ratchet.ts) and board-approval.ts reads `explicitLevel(agent,
-- capability, action)` off those rows. Renaming the capability in code alone leaves every recorded
-- level filed under a name nothing asks for again: the agent would fall back to its default level
-- for every vault action. That is the SAFE direction (it asks more, never less — manifest.ts's
-- DEFAULT_AUTONOMY is "gated") but it silently discards what the owner decided, so the rows move.
--
-- WHERE THEY MOVE TO: THE AREA IS THE ACTION (W5C controller ruling, 2026-09-19). The old
-- capability name WAS the area — `brain` meant the personal store, `atlas` the shared one,
-- `memory` the standing facts — and each recorded ONE capability-wide default, `action = ''`.
-- Renaming all three to `vault` and leaving them at `action = ''` would collapse three of the
-- owner's decisions into one row: switching the shared-store proposal lane to ✓ would switch
-- `forget` to ✓ with it. So a capability-default row moves to the AREA its old name meant:
--
--     brain  , ''  ->  vault, 'private'
--     atlas  , ''  ->  vault, 'shared'
--     memory , ''  ->  vault, 'facts'
--
-- That is 1:1 — three distinct source keys onto three distinct target keys — so no two of them can
-- collide and none is dropped. `packages/agent-kit/src/board-approval.ts` derives exactly the same
-- key from `areaOfTool(tool)`, in one place, for every board-approved vault tool.
--
-- A row with a NON-EMPTY action keeps its action (the action was never the capability), so
-- `brain, 'write'` and `memory, 'write'` DO both target `vault, 'write'` and the collision rule
-- below still decides between them.
--
-- WHICH TABLES, AND WHICH FILE CREATES EACH. Both are numbered BELOW 39, so the CI image probe
-- does not apply them from disk by glob — it hand-builds them (services/keeper/tests/
-- runtime-image.probe.py), and this change adds both hand-builds there, because neither table
-- existed in the probe's database before now:
--   ratchet          008_ratchet.sql
--   approval_events  038_permissions_board.sql (that file's third table, agent_registry, names
--                    agents, not capabilities, and is untouched)
--
-- THE COLLISION RULE: THE NARROWEST LEVEL WINS. `ratchet.level`'s own CHECK constraint names the
-- only three levels this box uses today — never, gated, autonomous (packages/agent-kit/src/
-- manifest.ts's AUTONOMY_LEVELS; "always-ask" is a tool-classification word from always-ask.ts,
-- not a ratchet level, and does not appear in this file) — ordered narrowest (most restrictive)
-- to widest: never < gated < autonomous. Where two rows would land on the SAME (agent, 'vault',
-- action) — a non-empty action recorded under two of the old names, or an old name's default
-- landing on an area a newer image has already written — the wider row is dropped first, and the
-- narrower level survives under the one key. A tie (two or three rows at the same level) keeps
-- exactly one, tie-broken by ctid, rather than leaving more than one row to collide once renamed.
--
-- THE ONE ROW THIS FILE REFUSES TO TOUCH: `vault` at `action = ''`. Only a newer image can have
-- written it, and nothing in this database says which of the three areas the owner meant by it.
-- Guessing would hand one area a level meant for another — the exact widening this file exists to
-- prevent — so it is left exactly as it is and REPORTED in the findings, for the owner to set
-- again on the permissions board. Nothing else targets `('vault', '')`, so it never collides.
--
-- WHY approval_events NEEDS NO COLLISION RULE, AND NO ACTION. It is an append-only evidence log —
-- its only uniqueness is on `call_id`, not on (agent, capability, tool) — so two old rows under
-- different capability names simply become two old rows under `vault`. Nothing is dropped there.
-- And 038 gives it NO `action` column, so the area cannot be written into it: this file does what
-- the columns allow, the capability and nothing else. The area is still recoverable from each
-- row — the `tool` column names the tool, and `areaOfTool` reads the area back off that, which is
-- how the console attributes a vault decision to one of the three rows.
--
-- THE ROLLBACK IS NOW HALF REAL, AND SAYS WHICH HALF. Because the three capability defaults land
-- on three DISTINCT areas, that move is reversible exactly: private → brain, shared → atlas,
-- facts → memory, back to `action = ''`. The ROLLBACK block below is that statement, and
-- `services/box/tests/capability-rename.test.ts` runs forward → back → forward and pins that all
-- three land in the same place. It is deliberately not conditional on where a row came from: a
-- `vault`/`private` level an owner set on the NEW board is read by old code as `brain`/`''` and
-- nowhere else, so re-filing it there is the correct restore, not a guess.
--
-- The other half stays lossy, with no new table to carry the difference:
--   * a row DROPPED by the collision rule is gone outright;
--   * a NON-EMPTY action's old capability name is gone (`brain, 'write'` and `atlas, 'write'` are
--     one `vault, 'write'` row and nothing says which it was);
--   * `approval_events` has no action column, so its rows carry no area to put back.
-- Recovering those would need somewhere to remember them before renaming — a small
-- `capability_rename_077_log` table — which is deliberately NOT built: a permanent table whose only
-- job is to undo one migration is a worse standing cost than the one-time loss it would guard
-- against. Nothing is lost by leaving that half unrecovered that the rename itself did not already
-- lose, because a ratchet lookup that finds no row under the key it asked for already falls back to
-- a SAFE default (asks more, never less) in EITHER direction. A code rollback is therefore never
-- made less safe by leaving this migration applied.
--
-- ORDER: apply this BEFORE the image that ships the rename (wave-5 plan, 5C deploy-notes table).
-- Between the two, nothing reads 'vault' and the moved rows are simply unused; after the image,
-- they are found again. Applying the image first is also safe, only slower to notice: every
-- capability falls back to its default level until this file runs.
--
-- Hand-applied over SSH, and possibly twice (the box has no auto-migrate). ONE TRANSACTION,
-- idempotent: a second run finds no brain/atlas/memory rows left to move or drop.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- FIRST, A DRY RUN. Paste the SELECT between the two markers below into psql on the box and read
-- its output before applying anything. It writes nothing. It lists every ratchet row under
-- brain/atlas/memory/vault and every approval_events row under the three old names, and what this
-- file would do with each: "WOULD BECOME vault/<area or action>", "WOULD BE DROPPED" (a wider
-- duplicate for the same agent and target action), "ALREADY vault/<action> - stays", or the one
-- row it refuses to guess at.
-- (`services/box/tests/capability-rename.test.ts` greps this SELECT out of this file and runs it,
-- so it cannot drift away from the migration below it.)
--
-- DRY RUN SELECT — BEGIN
-- WITH targeted AS (
--     SELECT agent, capability, action, level, ctid,
--            CASE WHEN capability = 'vault'    THEN action
--                 WHEN action <> ''            THEN action
--                 WHEN capability = 'brain'    THEN 'private'
--                 WHEN capability = 'atlas'    THEN 'shared'
--                 WHEN capability = 'memory'   THEN 'facts'
--            END AS target_action
--       FROM ratchet
--      WHERE capability IN ('brain', 'atlas', 'memory', 'vault')
--   ),
--   ranked AS (
--     SELECT targeted.*, row_number() OVER (
--              PARTITION BY agent, target_action
--              ORDER BY (CASE level WHEN 'never' THEN 0 WHEN 'gated' THEN 1 WHEN 'autonomous' THEN 2 END), ctid
--            ) AS rn
--       FROM targeted
--   )
-- SELECT 'ratchet' AS table_name, agent, action, capability, level,
--        CASE WHEN capability = 'vault' AND action = ''
--               THEN 'STAYS UNTOUCHED - cannot tell which area this was meant for; set it again on the permissions board'
--             WHEN rn > 1
--               THEN 'WOULD BE DROPPED - a narrower level for this agent/action already wins'
--             WHEN capability = 'vault'
--               THEN 'ALREADY vault/' || action || ' - stays'
--             ELSE 'WOULD BECOME vault/' || target_action
--        END AS what_077_would_do
--   FROM ranked
-- UNION ALL
-- SELECT 'approval_events', agent, NULL, capability, NULL,
--        'WOULD BECOME vault - capability only, this table has no action column'
--   FROM approval_events
--  WHERE capability IN ('brain', 'atlas', 'memory')
--  ORDER BY 1, 2, 3;
-- DRY RUN SELECT — END
--
-- The dry run reads only `ratchet` and `approval_events`; on a database missing either (there is
-- no such box today — the CI probe is the one place that builds them by hand) it errors on that
-- half rather than answering, which is the honest result: there is nothing there to predict.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- ROLLBACK — BEGIN
-- BEGIN;
-- SET LOCAL lares.actor = 'migration-077-rollback';
-- UPDATE ratchet
--    SET capability = CASE action WHEN 'private' THEN 'brain'
--                                 WHEN 'shared'  THEN 'atlas'
--                                 WHEN 'facts'   THEN 'memory' END,
--        action = ''
--  WHERE capability = 'vault'
--    AND action IN ('private', 'shared', 'facts');
-- COMMIT;
-- -- Only the three area lanes go back, and that half goes back exactly (see "THE ROLLBACK IS NOW
-- -- HALF REAL" above). A `vault` row at any OTHER action, a row dropped by the collision rule and
-- -- every approval_events row stay where they are — nothing here guesses which of the three names
-- -- they used to carry.
-- ROLLBACK — END

BEGIN;

-- 038_permissions_board.sql's own trigger comment: whoever deletes a ratchet row should
-- `SET lares.actor` first, or the audit row says 'unknown'. This migration is the deleter for
-- the collision case below, so it names itself rather than leaving that audit trail blank.
SET LOCAL lares.actor = 'migration-077';

-- The report, as a RESULT SET rather than RAISE NOTICE, so a script, a test and a human reading
-- psql all see the same thing. It disappears when the transaction commits.
CREATE TEMP TABLE migration_077_findings (
  table_name  text,
  agent       text,
  action      text,
  capability  text,
  level       text,
  row_count   bigint,
  finding     text
) ON COMMIT DROP;

DO $migration_077$
DECLARE
  changed bigint;
BEGIN
  IF to_regclass('ratchet') IS NULL THEN
    INSERT INTO migration_077_findings (table_name, finding)
    VALUES ('ratchet', 'ok, skipped - this table is not in this database, so there was nothing to change');
  ELSE
    -- Collisions first, decided on the key each row would LAND on, not the key it has: the
    -- `action = ''` rows spread onto three areas and cannot collide with each other, so what is
    -- left to collide is a non-empty action recorded under two old names, and an old name's
    -- default landing on an area a newer image already wrote. Keep the narrowest level (never <
    -- gated < autonomous), tie-broken by ctid so exactly one survives even when two or three rows
    -- share a level. The dropped row is reported by name, action and the level it carried —
    -- nothing here is a silent delete.
    WITH targeted AS (
      SELECT ctid, agent, capability, action, level,
             CASE WHEN capability = 'vault'    THEN action
                  WHEN action <> ''            THEN action
                  WHEN capability = 'brain'    THEN 'private'
                  WHEN capability = 'atlas'    THEN 'shared'
                  WHEN capability = 'memory'   THEN 'facts'
             END AS target_action
        FROM ratchet
       WHERE capability IN ('brain', 'atlas', 'memory', 'vault')
    ),
    ranked AS (
      SELECT targeted.*, row_number() OVER (
               PARTITION BY agent, target_action
               ORDER BY (CASE level WHEN 'never' THEN 0 WHEN 'gated' THEN 1 WHEN 'autonomous' THEN 2 END), ctid
             ) AS rn
        FROM targeted
    ),
    dropped AS (
      DELETE FROM ratchet r
       USING ranked k
       WHERE r.ctid = k.ctid
         AND k.rn > 1
      RETURNING r.agent, r.action, r.capability, r.level
    )
    INSERT INTO migration_077_findings (table_name, agent, action, capability, level, row_count, finding)
    SELECT 'ratchet', agent, action, capability, level, count(*),
           'dropped - a narrower level for this agent/action was already recorded under another '
           'of brain/atlas/memory/vault; this wider row is discarded so the rename never widens '
           'what the owner approved'
      FROM dropped
     GROUP BY agent, action, capability, level;

    -- The move itself. Every SET expression reads the OLD row, so `action` here is the area the
    -- old capability name meant — and a row that already named an action keeps it.
    UPDATE ratchet
       SET capability = 'vault',
           action = CASE WHEN action <> ''            THEN action
                         WHEN capability = 'brain'    THEN 'private'
                         WHEN capability = 'atlas'    THEN 'shared'
                         WHEN capability = 'memory'   THEN 'facts'
                    END
     WHERE capability IN ('brain', 'atlas', 'memory');
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed > 0 THEN
      INSERT INTO migration_077_findings (table_name, row_count, finding)
      VALUES ('ratchet', changed, 'ok, renamed - these rows now read capability = vault, keyed on the area their old name meant');
    END IF;

    -- Run AFTER the move, so what is left at `action = ''` is only what a newer image wrote.
    -- Reported on every run, including the second: the row stays unreadable until a human sets it.
    INSERT INTO migration_077_findings (table_name, agent, action, capability, level, row_count, finding)
    SELECT 'ratchet', agent, action, capability, level, count(*),
           'left untouched - cannot tell which area this was meant for, so nothing is guessed; '
           'set it again on the permissions board, per area'
      FROM ratchet
     WHERE capability = 'vault'
       AND action = ''
     GROUP BY agent, action, capability, level;
  END IF;

  IF to_regclass('approval_events') IS NULL THEN
    INSERT INTO migration_077_findings (table_name, finding)
    VALUES ('approval_events', 'ok, skipped - this table is not in this database, so there was nothing to change');
  ELSE
    -- Capability only: 038 gives this table no action column (see "WHY approval_events NEEDS NO
    -- COLLISION RULE, AND NO ACTION" above). Its `tool` column already names the area.
    UPDATE approval_events SET capability = 'vault' WHERE capability IN ('brain', 'atlas', 'memory');
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed > 0 THEN
      INSERT INTO migration_077_findings (table_name, row_count, finding)
      VALUES ('approval_events', changed, 'ok, renamed - these evidence rows now read capability = vault');
    END IF;
  END IF;
END
$migration_077$;

-- "dropped" sorts before "left" before "ok" on purpose: the things that needed a judgement call,
-- or that the owner still has to decide, are the first things on the screen.
SELECT table_name, agent, action, capability, level, row_count, finding
  FROM migration_077_findings
 ORDER BY finding, table_name NULLS FIRST, agent NULLS FIRST;

COMMIT;
