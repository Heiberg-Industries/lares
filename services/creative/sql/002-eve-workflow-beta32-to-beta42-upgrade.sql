-- eve workflow schema upgrade: @workflow/world-postgres beta.32 → beta.42 (W2-s8c)
--
-- WHY THIS FILE EXISTS. `001-eve-workflow.sql` is regenerated whole, every time, from whatever
-- version of @workflow/world-postgres is installed (see that file's own header and
-- `pnpm regen:eve-sql:check`) — it is not a migration, it is "the final schema, today". That is
-- fine for a fresh install, but this box has no auto-migrate and a real installation already has
-- rows in `workflow.workflow_events` (pending approvals, session history) sitting under the
-- OLD final schema. Applying the newly regenerated `001-eve-workflow.sql` straight over that
-- database fails:
--
--   ERROR: multiple primary keys for table "workflow_events" are not allowed
--
-- because the old primary key is named `workflow_events_pkey` on (id) alone, and the
-- regenerated file only checks for a constraint already named `workflow_events_run_id_id_pk`
-- before adding it — it has no idea the old one, under its old name, is still there. This file
-- is the missing step: run it ONCE, by hand, between the old `001-eve-workflow.sql` and the
-- regenerated one, on an existing installation's database.
--
-- SOURCE OF THE ACTUAL CHANGE. Not invented here. @workflow/world-postgres ships its own
-- drizzle migrations (`src/drizzle/migrations`, the folder its `bootstrap` CLI replays — see
-- `dist/cli.js`'s `setupDatabase()`); the migration that makes exactly this change is
-- `0019_add_event_slots.sql` in the installed beta.42 package
-- (node_modules/.pnpm/@workflow+world-postgres@5.0.0-beta.42.../node_modules/@workflow/world-postgres/src/drizzle/migrations/0019_add_event_slots.sql).
-- The two statements below are that migration's own DROP CONSTRAINT / ADD CONSTRAINT / DROP
-- INDEX, taken over near verbatim (its lock_timeout guard included), then wrapped so they are
-- safe to run against a database in any of the three states this box can actually be in: still
-- on the old schema with real rows, already moved to the new schema, or not yet initialised at
-- all. `0019` itself assumes exactly one incoming shape (mid-chain, migrations 0000-0018 already
-- applied) — ours cannot assume that, because this repo replaces the whole chain with one
-- generated final-schema file per version, so every statement here is guarded on the CURRENT
-- state of the database rather than on "the previous migration definitely ran".
--
-- IMPORTANT — WHAT `0019` ALSO DOES THAT THIS FILE DOES NOT: it creates
-- `workflow.workflow_event_slots`. This file does not, on purpose — the regenerated
-- `001-eve-workflow.sql` already creates that table with `CREATE TABLE IF NOT EXISTS` and adds
-- its primary key the same guarded way every other table in that file does, so it needs no help
-- here. This file's only job is the one thing the regenerated file cannot do safely on its own:
-- retire the OLD `workflow_events` primary key under its OLD name.
--
-- WHY THE NEW COMPOSITE KEY CAN ALWAYS BE BUILT. The old primary key was on `id` ALONE, so every
-- `id` in `workflow.workflow_events` was already globally unique across every run. A composite
-- key on `(run_id, id)` is a strictly weaker uniqueness requirement than "id is unique on its
-- own" — anything unique by `id` alone is automatically unique by `(run_id, id)` too. So there is
-- no existing row, and no combination of old rows, that can make
-- `ADD CONSTRAINT workflow_events_run_id_id_pk PRIMARY KEY (run_id, id)` fail with a duplicate-key
-- error. The only way it could ever fail is a table that was hand-edited to break the old key's
-- own uniqueness before this file ran, which is a different, pre-existing problem this file
-- cannot and does not attempt to detect.
--
-- IDEMPOTENT. Safe to run on:
--   · a database still on the old beta.32 shape, with real rows — the intended case;
--   · a database already on the new beta.42 shape (fresh install, or a previous run of this
--     same file) — every statement below is a no-op there;
--   · a database that has never seen ANY version of `001-eve-workflow.sql` — `workflow` and
--     `workflow.workflow_events` do not exist yet, and the whole body is skipped rather than
--     erroring on a missing relation.
-- Run it again as many times as you like; the second run changes nothing.
--
-- NEVER DROPS OR REWRITES A ROW. Every statement here is schema-only (constraints and an index).
--
-- ONE TRANSACTION. Everything between BEGIN and COMMIT commits together or not at all — a
-- failure partway through leaves the database exactly as it was before this file ran.
--
-- AFTER THIS FILE. The regenerated `001-eve-workflow.sql` applies cleanly on top: its
-- `CREATE TABLE IF NOT EXISTS` statements are no-ops for tables that already exist, its
-- `workflow_events_run_id_id_pk` guard now finds the constraint this file already added and
-- skips re-adding it, and it never re-creates `workflow_events_run_id_index` (that index is
-- retired below and is not part of the new schema).

BEGIN;

-- Matches `0019_add_event_slots.sql`'s own guard: replacing a primary key takes an ACCESS
-- EXCLUSIVE lock, which queues behind and then blocks every other reader and writer. Ten
-- seconds is a blip on the table sizes a single-installation box actually has; failing instead
-- of waiting indefinitely leaves this file unapplied and safely retryable rather than turning one
-- slow reader into an outage. Raise it by hand for a bigger table.
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
    -- Nothing to migrate on a database that has never had ANY version of this schema applied —
    -- the regenerated 001-eve-workflow.sql creates the table itself, on the new shape directly.
    IF to_regclass('workflow.workflow_events') IS NOT NULL THEN
        -- Drop the old single-column primary key under its old name, if this database still
        -- carries it. `IF EXISTS` makes this a no-op on a database already upgraded (by a
        -- previous run of this file, or because it started on the new schema).
        ALTER TABLE workflow.workflow_events DROP CONSTRAINT IF EXISTS workflow_events_pkey;

        -- Add the new composite primary key, unless it is already there.
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'workflow_events_run_id_id_pk'
               AND connamespace = 'workflow'::regnamespace
        ) THEN
            ALTER TABLE workflow.workflow_events
                ADD CONSTRAINT workflow_events_run_id_id_pk PRIMARY KEY (run_id, id);
        END IF;

        -- Redundant once the primary key leads with run_id (see the header's "why it can always
        -- be built" note — every by-run lookup this index served, the new key now serves too).
        -- Not part of the regenerated schema; `IF EXISTS` makes this safe to run any number of
        -- times.
        DROP INDEX IF EXISTS workflow.workflow_events_run_id_index;
    END IF;
END $$;

COMMIT;
