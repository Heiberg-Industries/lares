-- eve-calliope: @workflow/world-postgres@5.0.0-beta.32 schema (extracted for manual box deploy)
--
-- GENERATED BODY — do not hand-edit below the first `CREATE SCHEMA`. Everything from that
-- line down is derived from the INSTALLED @workflow/world-postgres by replaying the package's
-- own migrations (`src/drizzle/migrations`, the folder its bootstrap CLI runs) into a
-- disposable Postgres 16 and dumping the result, then rewriting each statement to be safe to
-- re-run. This header is hand-written and is preserved across regenerations.
--
--   pnpm regen:eve-sql          rewrite the DDL body from the installed package
--   pnpm regen:eve-sql:check    exit 1 if the committed body has drifted from it
--
-- Run the check after every @workflow/world-postgres bump. The box has no auto-migrate, so a
-- schema change that rides through unnoticed is not discovered until a restore. Needs Docker;
-- deliberately NOT part of `pnpm test`. Script and full provenance:
-- `packages/agent-kit/bin/regen-eve-workflow-sql.ts` (ORB-153).
--
-- WHAT THE CHECK COMPARES: statements, not bytes. This file wraps one statement — `ALTER
-- TABLE ONLY workflow_drizzle.workflow_migrations ALTER COLUMN id SET DEFAULT nextval(...)`
-- — over two lines where pg_dump emits it on one. That is layout, not schema, so the check
-- passes it: as of 2026-09-03 on @workflow/world-postgres@5.0.0-beta.32 all 33 statements are
-- identical and `regen:eve-sql:check` exits 0. It exits 1 only when a statement's own text
-- differs — a renamed column, a widened type, a dropped index. Left unregenerated on purpose:
-- the file below is what has actually been applied to the box.
--
-- APPLY THIS INTO ITS OWN DATABASE: `lares_calliope`, NOT `lares_state`.
--
--   WORKFLOW_POSTGRES_URL = postgres://lares@db:5432/lares_calliope
--   DATABASE_URL          = postgres://lares@db:5432/lares_state
--
-- Why a separate database and not a separate schema: `@workflow/world-postgres@5.0.0-beta.32`
-- offers NO schema override. The names `workflow` and `workflow_drizzle` below are string
-- literals inside the package itself (the drizzle schema in `dist/drizzle/schema.d.ts`, the
-- migration schema in `dist/cli.js`); its `jobPrefix` and `namespace` options prefix graphile
-- LISTEN topics only, never tables. So this file is eve-saga's copy UNCHANGED in its schema
-- names — they cannot be changed — and the isolation is at the database level instead.
-- (`dist/index.js` reads WORKFLOW_POSTGRES_URL first and falls back to DATABASE_URL, which is
-- what makes the split above work with no code change.)
--
-- That isolation is not theoretical. On 2026-08-17 two eve apps sharing one workflow database
-- shared one session store and one graphile queue, and Saga answered a conversation Bendik was
-- having with Marcel. `services/box/compose.yaml` has carried the standing rule since:
-- *"RULE FOR EVERY FUTURE EVE APP ON THIS BOX: its own workflow database, always."*
--
-- The good consequence of the other half — `DATABASE_URL` staying on `lares_state` — is that
-- `getPool()` (@lares/agent-kit/db) still points at the shared state database, so Calliope's
-- `studio_runs` table stays the SAME table the old agent-runtime Calliope has been writing to.
-- Her run history carries across the cutover instead of forking into an empty copy.
--
-- Everything below this line is eve-saga's sql/001-eve-workflow.sql verbatim; its own
-- provenance notes follow.
--
-- The box has no auto-migrate — nobody runs `drizzle migrate` or the package's `bootstrap`
-- CLI (`pnpm dlx --package @workflow/world-postgres bootstrap`) against the box's Postgres.
-- `createWorld().start()` (what `eve start`/`eve dev` actually calls at runtime) does NOT
-- run this DDL itself; only the bootstrap CLI does. This file is the hand-extracted
-- equivalent, meant to be applied once by hand before the box's eve-calliope container starts.
--
-- Extracted 2026-08-11 by running the package's own `setupDatabase()` (from
-- `@workflow/world-postgres/cli`) against a disposable local Postgres, then
-- `pg_dump --schema-only --schema=workflow --schema=workflow_drizzle` on the result — this is
-- the real, final schema across all 19 of the package's internal migrations (0000-0018)
-- (services/chief-of-staff/node_modules/eve → .pnpm/@workflow+world-postgres@.../src/drizzle/migrations),
-- not a hand-transcription of each incremental migration file. Every statement below is
-- rewritten to be safe to re-run (IF NOT EXISTS, or a DO block catching duplicate_object for
-- the two DDL forms Postgres doesn't offer that clause for: CREATE TYPE and ADD CONSTRAINT).
--
-- Deliberately NOT included: the `graphile_worker` schema. That schema backs the package's
-- job queue (graphile-worker) and is self-provisioning — `createWorld().start()` calls
-- graphile-worker's own `run()`/`makeWorkerUtils()`, which installs and migrates its schema
-- automatically on first connect via its own idempotent internal DDL. Nothing needs to be
-- hand-applied for it. (The package's own README flags a startup race if *multiple* processes
-- call `start()` against a fresh DB concurrently — e.g. several replicas cold-starting at
-- once — since graphile-worker's own `CREATE SCHEMA IF NOT EXISTS` isn't safe under
-- concurrent DDL. Not a concern for a single eve-calliope instance; worth another look if the
-- box ever runs eve-calliope as more than one replica.)
--
-- Also deliberately NOT included: rows in workflow_drizzle.workflow_migrations (the
-- migration-tracking table drizzle's own `migrate()` reads/writes). Populating it with
-- fabricated hashes would only matter if someone later ran the official drizzle-orm
-- `migrate()`/bootstrap CLI against the box — which per box discipline (no auto-migrate, SQL
-- applied by hand) is exactly what should NOT happen there. Leave the table empty; this file
-- is the box's canonical schema source, not drizzle's migrator.

CREATE SCHEMA IF NOT EXISTS workflow;

CREATE SCHEMA IF NOT EXISTS workflow_drizzle;

-- CREATE TYPE has no IF NOT EXISTS in Postgres; guard with a DO block instead.
DO $$ BEGIN
    CREATE TYPE workflow.status AS ENUM (
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE workflow.step_status AS ENUM (
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE workflow.wait_status AS ENUM (
        'waiting',
        'completed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workflow.workflow_event_slots (
    run_id character varying NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow.workflow_events (
    id character varying NOT NULL,
    type character varying NOT NULL,
    correlation_id character varying,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    run_id character varying NOT NULL,
    payload jsonb,
    payload_cbor bytea,
    spec_version integer
);

CREATE TABLE IF NOT EXISTS workflow.workflow_hooks (
    run_id character varying NOT NULL,
    hook_id character varying NOT NULL,
    token character varying NOT NULL,
    owner_id character varying NOT NULL,
    project_id character varying NOT NULL,
    environment character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    metadata jsonb,
    metadata_cbor bytea,
    spec_version integer,
    is_webhook boolean DEFAULT true,
    is_system boolean DEFAULT false,
    resume_context bytea,
    token_retention_until timestamp with time zone
);

CREATE TABLE IF NOT EXISTS workflow.workflow_runs (
    id character varying NOT NULL,
    output jsonb,
    deployment_id character varying NOT NULL,
    status workflow.status NOT NULL,
    name character varying NOT NULL,
    execution_context jsonb,
    input jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    started_at timestamp without time zone,
    output_cbor bytea,
    execution_context_cbor bytea,
    input_cbor bytea,
    expired_at timestamp without time zone,
    spec_version character varying,
    error_cbor bytea,
    error_code character varying,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    encryption_public_key character varying
);

CREATE TABLE IF NOT EXISTS workflow.workflow_steps (
    run_id character varying NOT NULL,
    step_id character varying NOT NULL,
    step_name character varying NOT NULL,
    status workflow.step_status NOT NULL,
    input jsonb,
    output jsonb,
    error text,
    attempt integer NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    retry_after timestamp without time zone,
    input_cbor bytea,
    output_cbor bytea,
    error_cbor bytea,
    spec_version integer
);

CREATE TABLE IF NOT EXISTS workflow.workflow_stream_chunks (
    id character varying NOT NULL,
    stream_id character varying NOT NULL,
    data bytea NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    eof boolean NOT NULL,
    run_id character varying
);

CREATE TABLE IF NOT EXISTS workflow.workflow_waits (
    wait_id character varying NOT NULL,
    run_id character varying NOT NULL,
    status workflow.wait_status NOT NULL,
    resume_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    spec_version integer
);

CREATE TABLE IF NOT EXISTS workflow_drizzle.workflow_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);

CREATE SEQUENCE IF NOT EXISTS workflow_drizzle.workflow_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE workflow_drizzle.workflow_migrations_id_seq OWNED BY workflow_drizzle.workflow_migrations.id;

ALTER TABLE ONLY workflow_drizzle.workflow_migrations ALTER COLUMN id SET DEFAULT nextval('workflow_drizzle.workflow_migrations_id_seq'::regclass);

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres. A duplicate PRIMARY KEY isn't reported as
-- `duplicate_object` (42710) — Postgres raises `invalid_table_definition` ("multiple primary
-- keys ... are not allowed") instead — so guard with an explicit pg_constraint existence
-- check rather than an exception handler keyed on the wrong SQLSTATE.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_event_slots_pkey' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_event_slots
            ADD CONSTRAINT workflow_event_slots_pkey PRIMARY KEY (run_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_events_run_id_id_pk' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_events
            ADD CONSTRAINT workflow_events_run_id_id_pk PRIMARY KEY (run_id, id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_hooks_pkey' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_hooks
            ADD CONSTRAINT workflow_hooks_pkey PRIMARY KEY (hook_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_pkey' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_runs
            ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_steps_pkey' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_steps
            ADD CONSTRAINT workflow_steps_pkey PRIMARY KEY (step_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_stream_chunks_stream_id_id_pk' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_stream_chunks
            ADD CONSTRAINT workflow_stream_chunks_stream_id_id_pk PRIMARY KEY (stream_id, id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_waits_pkey' AND connamespace = 'workflow'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow.workflow_waits
            ADD CONSTRAINT workflow_waits_pkey PRIMARY KEY (wait_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflow_migrations_pkey' AND connamespace = 'workflow_drizzle'::regnamespace
    ) THEN
        ALTER TABLE ONLY workflow_drizzle.workflow_migrations
            ADD CONSTRAINT workflow_migrations_pkey PRIMARY KEY (id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS workflow_events_correlation_id_index ON workflow.workflow_events USING btree (correlation_id);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_entity_creation_unique ON workflow.workflow_events USING btree (run_id, correlation_id, type) WHERE ((type)::text = ANY ((ARRAY['step_created'::character varying, 'hook_created'::character varying, 'wait_created'::character varying, 'attr_set'::character varying])::text[]));

CREATE INDEX IF NOT EXISTS workflow_hooks_run_id_index ON workflow.workflow_hooks USING btree (run_id);

CREATE INDEX IF NOT EXISTS workflow_hooks_token_index ON workflow.workflow_hooks USING btree (token);

CREATE INDEX IF NOT EXISTS workflow_runs_name_index ON workflow.workflow_runs USING btree (name);

CREATE INDEX IF NOT EXISTS workflow_runs_status_index ON workflow.workflow_runs USING btree (status);

CREATE INDEX IF NOT EXISTS workflow_steps_run_id_index ON workflow.workflow_steps USING btree (run_id);

CREATE INDEX IF NOT EXISTS workflow_steps_status_index ON workflow.workflow_steps USING btree (status);

CREATE INDEX IF NOT EXISTS workflow_stream_chunks_run_id_index ON workflow.workflow_stream_chunks USING btree (run_id);

CREATE INDEX IF NOT EXISTS workflow_waits_run_id_index ON workflow.workflow_waits USING btree (run_id);
