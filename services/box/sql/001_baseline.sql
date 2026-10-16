-- 001_baseline.sql: the Lares box schema, in one file.
--
-- WHAT THIS IS. The whole schema of the box's shared state database (the database the keeper, the
-- console and every agent read), as the first public release creates it. It replaces the numbered
-- history this folder carried before that release; nothing here is an incremental step. A fresh
-- installation applies this file and nothing else. `pnpm -C services/box migrate` records it in
-- `schema_migrations` like any other migration, and every later change ships as a new file numbered
-- above 001.
--
-- WHAT IT DOES NOT CONTAIN. Tables a service creates for itself at run time (the dream tables,
-- created by the chief of staff's own code), eve's workflow schema (each role's
-- `sql/001-eve-workflow.sql`, applied into the agent's own database), and any row of installation
-- data. The only rows below are the ones the code expects to find on a fresh database: the voice
-- profile's shared card, the two backup checks, the notion sync marker and one heartbeat row per
-- schedule, so a schedule that has not run yet reads as "not yet", not as "missing".
--
-- A DATABASE THAT ALREADY HOLDS THE PRE-RELEASE HISTORY must not run this file. The runner refuses,
-- and says how to mark it as applied instead (`migrate --adopt-through 001_baseline.sql`).
--
-- Generated from the final schema of the pre-release history, then renamed to neutral names; the
-- section headers below are pg_dump's, kept so a reader can find a table, an index or a constraint
-- by name.

BEGIN;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: ratchet_audit_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION ratchet_audit_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO ratchet_audit (agent, capability, action, old_level, new_level, changed_by)
    -- nullif: a SET-then-RESET actor reads back as '' rather than NULL.
    VALUES (OLD.agent, OLD.capability, OLD.action, OLD.level, NULL, coalesce(nullif(current_setting('lares.actor', true), ''), 'unknown'));
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.level = NEW.level THEN RETURN NEW; END IF;
  INSERT INTO ratchet_audit (agent, capability, action, old_level, new_level, changed_by)
  VALUES (NEW.agent, NEW.capability, NEW.action, CASE WHEN TG_OP = 'UPDATE' THEN OLD.level END, NEW.level, NEW.updated_by);
  RETURN NEW;
END $$;


--
-- Name: settings_audit_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION settings_audit_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD.value IS NOT DISTINCT FROM NEW.value THEN RETURN NEW; END IF;
 INSERT INTO settings_audit (key, old_value, new_value, changed_by)
 VALUES (NEW.key, CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END, NEW.value, NEW.updated_by);
 RETURN NEW;
END $$;


--
-- Name: update_history_images_are_digests(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION update_history_images_are_digests(images jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT jsonb_typeof(images) = 'object' AND images <> '{}'::jsonb AND NOT EXISTS (
    SELECT 1 FROM jsonb_each_text(images) AS e(k, v)
    WHERE v !~ '^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$')
$_$;




--
-- Name: agent_avatars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_avatars (
    name text NOT NULL,
    image bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_avatars_image_check CHECK ((octet_length(image) <= 262144))
);


--
-- Name: agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_conversations (
    agent text NOT NULL,
    incarnation uuid NOT NULL,
    session_id text NOT NULL,
    door text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    terminal boolean DEFAULT false NOT NULL
);


--
-- Name: agent_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_definitions (
    name text NOT NULL,
    definition jsonb NOT NULL,
    duties text DEFAULT ''::text NOT NULL,
    voice text DEFAULT ''::text NOT NULL,
    hash text NOT NULL,
    status text DEFAULT 'valid'::text NOT NULL,
    status_reason text,
    valid_at timestamp with time zone DEFAULT now() NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_folder text,
    CONSTRAINT agent_definitions_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'invalid'::text, 'retired'::text])))
);


--
-- Name: agent_door_claim_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_door_claim_audit (
    id bigint NOT NULL,
    agent text NOT NULL,
    kind text NOT NULL,
    incarnation uuid NOT NULL,
    principal text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_door_claim_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE agent_door_claim_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME agent_door_claim_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_door_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_door_connections (
    agent text NOT NULL,
    kind text NOT NULL,
    incarnation uuid NOT NULL,
    revision uuid NOT NULL,
    owner_email text NOT NULL,
    code_hash text,
    expires_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    principal text,
    org text,
    mailbox text,
    claimed_at timestamp with time zone,
    applied_revision uuid,
    applied_connection jsonb,
    webhook_set_at timestamp with time zone,
    CONSTRAINT agent_door_connections_attempts_check CHECK (((attempts >= 0) AND (attempts <= 10))),
    CONSTRAINT agent_door_connections_code_hash_check CHECK (((code_hash IS NULL) OR (code_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT agent_door_connections_kind_check CHECK ((kind = ANY (ARRAY['slack'::text, 'telegram'::text, 'email'::text])))
);


--
-- Name: agent_doors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_doors (
    agent text NOT NULL,
    kind text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    secret_set_at timestamp with time zone,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_notes (
    id bigint NOT NULL,
    owner text NOT NULL,
    agent text NOT NULL,
    kind text NOT NULL,
    note text NOT NULL,
    origin text NOT NULL,
    session_id text NOT NULL,
    turn_id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_notes_kind_check CHECK ((kind = ANY (ARRAY['working'::text, 'watch'::text, 'followup'::text]))),
    CONSTRAINT agent_notes_note_check CHECK (((length(note) >= 1) AND (length(note) <= 400))),
    CONSTRAINT agent_notes_origin_check CHECK ((origin = ANY (ARRAY['owner'::text, 'agent'::text, 'synced'::text, 'third_party'::text, 'system'::text]))),
    CONSTRAINT agent_notes_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: agent_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE agent_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE agent_notes_id_seq OWNED BY agent_notes.id;


--
-- Name: agent_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_registry (
    name text NOT NULL,
    display_name text NOT NULL,
    role text,
    grants jsonb NOT NULL,
    autonomy jsonb NOT NULL,
    skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    doors jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE agent_resources (
    name text NOT NULL,
    address inet NOT NULL,
    workflow_database text NOT NULL,
    ownership text NOT NULL,
    ownership_token uuid NOT NULL,
    state text NOT NULL,
    applied_definition jsonb,
    pending boolean DEFAULT true NOT NULL,
    pending_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    runtime_control_token uuid,
    CONSTRAINT agent_resources_ownership_check CHECK ((ownership = ANY (ARRAY['owned'::text, 'legacy'::text]))),
    CONSTRAINT agent_resources_state_check CHECK ((state = ANY (ARRAY['provisioning'::text, 'ready'::text, 'retired'::text, 'deleting'::text]))),
    CONSTRAINT runtime_control_current_incarnation CHECK (((runtime_control_token IS NULL) OR (runtime_control_token = ownership_token)))
);


--
-- Name: approval_asks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE approval_asks (
    request_id text NOT NULL,
    call_id text NOT NULL,
    agent text NOT NULL,
    tool text NOT NULL,
    payload_hash text NOT NULL,
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_at timestamp with time zone,
    outcome text,
    answered_via text,
    used_at timestamp with time zone,
    use_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT approval_asks_answered_check CHECK (((answered_at IS NULL) = (outcome IS NULL))),
    CONSTRAINT approval_asks_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['approved'::text, 'cancelled'::text, 'ignored'::text, 'invalid'::text, 'expired'::text, 'payload-changed'::text]))))
);


--
-- Name: approval_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE approval_events (
    id bigint NOT NULL,
    agent text NOT NULL,
    capability text NOT NULL,
    tool text NOT NULL,
    decision text NOT NULL,
    reason text,
    call_id text,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_events_decision_check CHECK ((decision = ANY (ARRAY['asked'::text, 'autonomous'::text, 'denied'::text, 'locked'::text, 'failed-closed'::text])))
);


--
-- Name: approval_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE approval_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: approval_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE approval_events_id_seq OWNED BY approval_events.id;


--
-- Name: atlas_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE atlas_notes (
    note_path text NOT NULL,
    brand text,
    accounted_sources_hash text,
    body_hash text,
    state text DEFAULT 'ok'::text NOT NULL,
    state_reason text,
    state_since timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT atlas_notes_state_check CHECK ((state = ANY (ARRAY['ok'::text, 'sources_failed'::text, 'sources_missing'::text])))
);


--
-- Name: atlas_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE atlas_proposals (
    id bigint NOT NULL,
    note_path text NOT NULL,
    proposed_note text NOT NULL,
    base_body_hash text NOT NULL,
    sources_hash text NOT NULL,
    diff_preview text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    announced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT atlas_proposals_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'applied'::text, 'superseded'::text])))
);


--
-- Name: atlas_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE atlas_proposals ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atlas_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE audit (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    agent text NOT NULL,
    session_id uuid,
    action text NOT NULL,
    credential text,
    args_summary text,
    confirm_id uuid,
    principal text
);


--
-- Name: audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE audit_id_seq OWNED BY audit.id;


--
-- Name: backup_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE backup_status (
    check_name text NOT NULL,
    ok boolean,
    checked_at timestamp with time zone,
    last_pass_at timestamp with time zone,
    detail text,
    target text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_status_check_name_check CHECK ((check_name = ANY (ARRAY['verify'::text, 'drill'::text])))
);


--
-- Name: brief_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE brief_settings (
    owner text NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brief_settings_language_check CHECK ((language ~ '^[a-z]{2}$'::text)),
    CONSTRAINT brief_settings_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: clipping_choice; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE clipping_choice (
    id boolean DEFAULT true NOT NULL,
    mode text NOT NULL,
    set_by text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clipping_choice_id_check CHECK (id),
    CONSTRAINT clipping_choice_mode_check CHECK ((mode = ANY (ARRAY['notion'::text, 'karakeep'::text, 'both'::text]))),
    CONSTRAINT clipping_choice_set_by_not_empty CHECK ((length(btrim(set_by)) > 0))
);


--
-- Name: clipping_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE clipping_items (
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    source_container text NOT NULL,
    owner text NOT NULL,
    visibility text NOT NULL,
    url_key text,
    source_revision timestamp with time zone,
    state text NOT NULL,
    skip_reason text,
    inbox_path text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_checked_at timestamp with time zone,
    CONSTRAINT clipping_items_skip_reason_check CHECK (((skip_reason IS NULL) OR (skip_reason = ANY (ARRAY['no-link'::text, 'duplicate'::text])))),
    CONSTRAINT clipping_items_state_check CHECK ((state = ANY (ARRAY['imported'::text, 'filed-unknown'::text, 'trashed'::text, 'skipped'::text]))),
    CONSTRAINT clipping_items_visibility_check CHECK ((visibility = ANY (ARRAY['shared'::text, 'private'::text])))
);


--
-- Name: clipping_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE clipping_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    outcome text,
    outcome_detail text,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT clipping_requests_detail_short CHECK (((outcome_detail IS NULL) OR (length(outcome_detail) <= 400))),
    CONSTRAINT clipping_requests_kind_check CHECK ((kind = ANY (ARRAY['schema'::text, 'test'::text, 'import'::text, 'add-properties'::text]))),
    CONSTRAINT clipping_requests_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['ok'::text, 'not-configured'::text, 'unsupported-source'::text, 'refused'::text, 'not-shared'::text, 'schema-mismatch'::text, 'rate-limited'::text, 'unavailable'::text, 'timeout'::text, 'incomplete'::text, 'key-unreadable'::text, 'local-error'::text])))),
    CONSTRAINT clipping_requests_requested_by_not_empty CHECK ((length(btrim(requested_by)) > 0)),
    CONSTRAINT clipping_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: clipping_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE clipping_sources (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    kind text NOT NULL,
    data_source_id text NOT NULL,
    url_property_id text NOT NULL,
    note_property_id text,
    tags_property_id text,
    saved_property_id text,
    credential_ref text DEFAULT 'notion:shared'::text NOT NULL,
    owner text NOT NULL,
    visibility text NOT NULL,
    import_since timestamp with time zone NOT NULL,
    watermark timestamp with time zone,
    watermark_capped boolean DEFAULT false NOT NULL,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    outcome text,
    outcome_detail text,
    last_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    imported_total integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clipping_sources_detail_short CHECK (((outcome_detail IS NULL) OR (length(outcome_detail) <= 400))),
    CONSTRAINT clipping_sources_kind_check CHECK ((kind = ANY (ARRAY['notion'::text, 'karakeep'::text]))),
    CONSTRAINT clipping_sources_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['ok'::text, 'not-configured'::text, 'unsupported-source'::text, 'refused'::text, 'not-shared'::text, 'schema-mismatch'::text, 'rate-limited'::text, 'unavailable'::text, 'timeout'::text, 'incomplete'::text, 'key-unreadable'::text, 'local-error'::text])))),
    CONSTRAINT clipping_sources_owner_not_empty CHECK ((length(btrim(owner)) > 0)),
    CONSTRAINT clipping_sources_visibility_check CHECK ((visibility = ANY (ARRAY['shared'::text, 'private'::text])))
);


--
-- Name: confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    action text NOT NULL,
    args jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    slack_channel text,
    slack_ts text,
    effect_result jsonb,
    consumed_at timestamp with time zone,
    CONSTRAINT confirmations_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text, 'consuming'::text, 'consumed'::text])))
);


--
-- Name: conversation_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE conversation_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent text NOT NULL,
    session_id text NOT NULL,
    turn_id text NOT NULL,
    door text NOT NULL,
    person_key text NOT NULL,
    lane text,
    origin text NOT NULL,
    input text NOT NULL,
    reply text NOT NULL,
    proposals text[] DEFAULT '{}'::text[] NOT NULL,
    at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_entries_origin_check CHECK ((origin = ANY (ARRAY['owner'::text, 'agent'::text, 'synced'::text, 'third_party'::text, 'system'::text])))
);


--
-- Name: conversation_retention; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE conversation_retention (
    owner text NOT NULL,
    months integer,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_retention_months_check CHECK (((months IS NULL) OR (months >= 1))),
    CONSTRAINT conversation_retention_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: cross_member_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE cross_member_grants (
    id bigint NOT NULL,
    grantor_user_id text NOT NULL,
    capability text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: cross_member_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE cross_member_grants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cross_member_grants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE cross_member_grants_id_seq OWNED BY cross_member_grants.id;


--
-- Name: cross_member_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE cross_member_reads (
    id bigint NOT NULL,
    grantor_user_id text NOT NULL,
    capability text NOT NULL,
    requested_by_user_id text NOT NULL,
    agent text NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cross_member_reads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE cross_member_reads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cross_member_reads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE cross_member_reads_id_seq OWNED BY cross_member_reads.id;


--
-- Name: deadline_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE deadline_candidates (
    owner text NOT NULL,
    thread_id text NOT NULL,
    subject text NOT NULL,
    sender text NOT NULL,
    seen_at timestamp with time zone NOT NULL,
    surfaced_at timestamp with time zone,
    resolution text,
    CONSTRAINT deadline_candidates_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT deadline_candidates_resolution_check CHECK ((resolution = ANY (ARRAY['added'::text, 'ignored'::text])))
);


--
-- Name: deadline_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE deadline_settings (
    owner text NOT NULL,
    ladder_enabled boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deadline_settings_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: deadlines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE deadlines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL,
    entity text NOT NULL,
    title text NOT NULL,
    source text NOT NULL,
    due_date date NOT NULL,
    recurrence text DEFAULT 'none'::text NOT NULL,
    consequence text,
    evidence_rule text DEFAULT 'owner confirms'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    status_reason text,
    resolved_at timestamp with time zone,
    rung integer DEFAULT 0 NOT NULL,
    rung_moved_at timestamp with time zone,
    rule_key text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vendor text,
    amount numeric(12,2),
    currency text,
    CONSTRAINT deadlines_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT deadlines_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT deadlines_recurrence_check CHECK ((recurrence = ANY (ARRAY['none'::text, 'yearly'::text, 'bimonthly'::text, 'monthly'::text]))),
    CONSTRAINT deadlines_rung_check CHECK (((rung >= 0) AND (rung <= 3))),
    CONSTRAINT deadlines_source_check CHECK ((source = ANY (ARRAY['statutory'::text, 'accounting'::text, 'contract'::text, 'subscription'::text, 'manual'::text, 'renewal'::text]))),
    CONSTRAINT deadlines_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'dismissed'::text])))
);


--
-- Name: digest_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE digest_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent text NOT NULL,
    requested_by text NOT NULL,
    door text NOT NULL,
    thread_ref text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT digest_requests_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text])))
);


--
-- Name: digest_skips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE digest_skips (
    agent text NOT NULL,
    path text NOT NULL,
    reason text NOT NULL,
    asked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_triage_processed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE email_triage_processed (
    mailbox text NOT NULL,
    gmail_message_id text NOT NULL,
    principal text NOT NULL,
    outcome text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    draft_id text,
    thread_id text
);


--
-- Name: email_watch_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE email_watch_cursors (
    watcher text NOT NULL,
    principal text NOT NULL,
    email_address text NOT NULL,
    last_polled_at bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forget_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE forget_ledger (
    id bigint NOT NULL,
    owner text NOT NULL,
    kind text NOT NULL,
    match_hash text NOT NULL,
    forgotten_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text NOT NULL,
    CONSTRAINT forget_ledger_kind_check CHECK ((kind = ANY (ARRAY['fact'::text, 'note'::text, 'preference'::text]))),
    CONSTRAINT forget_ledger_match_hash_check CHECK ((match_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT forget_ledger_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT forget_ledger_reason_check CHECK ((reason = ANY (ARRAY['forget'::text, 'erase-person'::text])))
);


--
-- Name: forget_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE forget_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forget_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE forget_ledger_id_seq OWNED BY forget_ledger.id;


--
-- Name: heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE heartbeat (
    agent text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: initiations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE initiations (
    id bigint NOT NULL,
    owner text NOT NULL,
    agent text NOT NULL,
    door text NOT NULL,
    cls text NOT NULL,
    item_key text NOT NULL,
    status text NOT NULL,
    reason text,
    until_at timestamp with time zone,
    owner_day date NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT initiations_cls_check CHECK ((cls = ANY (ARRAY['scheduled'::text, 'event'::text, 'escalation'::text]))),
    CONSTRAINT initiations_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT initiations_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'suppressed'::text, 'deferred'::text])))
);


--
-- Name: initiations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE initiations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: initiations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE initiations_id_seq OWNED BY initiations.id;


--
-- Name: keeper_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE keeper_audit (
    id bigint NOT NULL,
    operation_id uuid,
    action text NOT NULL,
    actor text NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome text NOT NULL,
    detail text,
    at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT keeper_audit_outcome_check CHECK ((outcome = ANY (ARRAY['pending'::text, 'ok'::text, 'refused'::text, 'failed'::text])))
);


--
-- Name: keeper_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE keeper_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keeper_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE keeper_audit_id_seq OWNED BY keeper_audit.id;


--
-- Name: keeper_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE keeper_credentials (
    slot text NOT NULL,
    version bigint NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT keeper_credentials_check CHECK (COALESCE(((jsonb_typeof(record) = 'object'::text) AND ((record ->> 'slot'::text) = slot) AND (((record ->> 'version'::text))::bigint = version)), false)),
    CONSTRAINT keeper_credentials_slot_check CHECK ((slot = 'notion:shared'::text)),
    CONSTRAINT keeper_credentials_version_check CHECK ((version > 0))
);


--
-- Name: meeting_followup_sent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE meeting_followup_sent (
    notion_page_id text NOT NULL,
    principal text NOT NULL,
    series_key text DEFAULT ''::text NOT NULL,
    outcome text NOT NULL,
    recipients_fingerprint text DEFAULT ''::text NOT NULL,
    recipients text DEFAULT ''::text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    summary_hash text
);


--
-- Name: COLUMN meeting_followup_sent.outcome; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN meeting_followup_sent.outcome IS 'sent | queued | skipped | error | denied — see lib/meeting-followup-store.ts FollowupOutcome. sent is the only terminal truth; denied/queued/error are all statements about an ATTEMPT.';


--
-- Name: memory_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE memory_proposals (
    id bigint NOT NULL,
    action text NOT NULL,
    existing_id text NOT NULL,
    existing_text text NOT NULL,
    proposed_text text DEFAULT ''::text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    origin text NOT NULL,
    source text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    announced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ref text DEFAULT ''::text NOT NULL,
    kind text DEFAULT ''::text NOT NULL,
    CONSTRAINT memory_proposals_action_check CHECK ((action = ANY (ARRAY['supersede'::text, 'retire'::text, 'add'::text]))),
    CONSTRAINT memory_proposals_origin_check CHECK ((((action = ANY (ARRAY['supersede'::text, 'retire'::text])) AND (origin = 'owner'::text)) OR ((action = 'add'::text) AND (origin = 'agent'::text)))),
    CONSTRAINT memory_proposals_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'applied'::text, 'superseded'::text]))),
    CONSTRAINT memory_proposals_text_check CHECK ((((action = 'supersede'::text) AND (length(proposed_text) > 0)) OR ((action = 'retire'::text) AND (proposed_text = ''::text)) OR ((action = 'add'::text) AND (length(proposed_text) > 0) AND (existing_text = ''::text) AND (existing_id = ''::text) AND (length(ref) > 0) AND (length(kind) > 0))))
);


--
-- Name: memory_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE memory_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE memory_proposals_id_seq OWNED BY memory_proposals.id;


--
-- Name: memory_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE memory_reads (
    session_id text NOT NULL,
    turn_id text NOT NULL,
    owner text NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_reads_kind_check CHECK ((kind = ANY (ARRAY['standing_fact'::text, 'preference'::text, 'vault_note'::text, 'agent_note'::text]))),
    CONSTRAINT memory_reads_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: memory_use; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE memory_use (
    kind text NOT NULL,
    ref text NOT NULL,
    owner text NOT NULL,
    first_used timestamp with time zone DEFAULT now() NOT NULL,
    last_used timestamp with time zone DEFAULT now() NOT NULL,
    uses integer DEFAULT 1 NOT NULL,
    CONSTRAINT memory_use_kind_check CHECK ((kind = ANY (ARRAY['standing_fact'::text, 'preference'::text]))),
    CONSTRAINT memory_use_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: notion_sync_docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE notion_sync_docs (
    id bigint NOT NULL,
    vault_path text,
    notion_page_id text NOT NULL,
    target text NOT NULL,
    direction text NOT NULL,
    md_hash text,
    notion_hash text,
    notion_last_edited timestamp with time zone,
    state text DEFAULT 'synced'::text NOT NULL,
    frozen_reason text,
    frozen_at timestamp with time zone,
    error_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notion_sync_docs_direction_check CHECK ((direction = ANY (ARRAY['two_way'::text, 'md_to_notion'::text, 'notion_to_md'::text]))),
    CONSTRAINT notion_sync_docs_state_check CHECK ((state = ANY (ARRAY['synced'::text, 'frozen'::text, 'error'::text, 'unmatched'::text, 'retrying'::text]))),
    CONSTRAINT notion_sync_docs_target_check CHECK ((target = ANY (ARRAY['docs'::text, 'meetings'::text])))
);


--
-- Name: notion_sync_docs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE notion_sync_docs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notion_sync_docs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE notion_sync_docs_id_seq OWNED BY notion_sync_docs.id;


--
-- Name: notion_sync_fidelity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE notion_sync_fidelity (
    vault_path text NOT NULL,
    passed boolean NOT NULL,
    reason text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notion_sync_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE notion_sync_proposals (
    id bigint NOT NULL,
    vault_path text NOT NULL,
    notion_page_id text NOT NULL,
    proposed_body text NOT NULL,
    base_md_hash text NOT NULL,
    notion_hash text NOT NULL,
    diff_preview text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    announced_at timestamp with time zone,
    kind text DEFAULT 'update'::text NOT NULL,
    CONSTRAINT notion_sync_proposals_kind_ck CHECK ((kind = ANY (ARRAY['update'::text, 'create'::text]))),
    CONSTRAINT notion_sync_proposals_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'applied'::text, 'superseded'::text])))
);


--
-- Name: notion_sync_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE notion_sync_proposals ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME notion_sync_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notion_sync_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE notion_sync_run (
    id boolean DEFAULT true NOT NULL,
    last_commit text,
    last_run_at timestamp with time zone,
    CONSTRAINT notion_sync_run_id_check CHECK (id)
);


--
-- Name: oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE oauth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal text NOT NULL,
    provider text NOT NULL,
    org_id text NOT NULL,
    email_address text NOT NULL,
    refresh_token_enc text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: obligation_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE obligation_threads (
    thread_id text NOT NULL,
    principal text NOT NULL,
    source text DEFAULT 'gmail'::text NOT NULL,
    counterparty_address text NOT NULL,
    last_message_at timestamp with time zone NOT NULL,
    last_speaker_is_them boolean NOT NULL,
    their_unanswered_count integer DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    reping_announced_at timestamp with time zone,
    reping_announced_count integer,
    night_before_delivered_day text,
    resolved_elsewhere_at timestamp with time zone,
    resolution_via text,
    resolution_evidence text,
    intent text,
    intent_for_message_at timestamp with time zone,
    CONSTRAINT obligation_threads_intent_check CHECK ((intent = ANY (ARRAY['expects_reply'::text, 'closes_loop'::text, 'fyi'::text, 'unreadable'::text])))
);


--
-- Name: org_member_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE org_member_policy (
    user_id text NOT NULL,
    allowed_capabilities text[],
    may_create_agents boolean DEFAULT true NOT NULL,
    spend_cap_usd_month numeric
);


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE orgs (
    id text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    domains text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: outreach_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE outreach_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id text NOT NULL,
    account text NOT NULL,
    person_id text,
    status text DEFAULT 'awaiting_reply'::text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    principal text NOT NULL,
    triage_started_at timestamp with time zone,
    CONSTRAINT outreach_threads_status_ck CHECK ((status = ANY (ARRAY['awaiting_reply'::text, 'replied'::text, 'stopped'::text])))
);


--
-- Name: outside_tool_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE outside_tool_pins (
    agent text NOT NULL,
    tool text NOT NULL,
    config_hash text NOT NULL,
    pin_hash text NOT NULL,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outside_tool_pins_hashes CHECK (((length(config_hash) = 64) AND (length(pin_hash) = 64)))
);


--
-- Name: owner_clock_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE owner_clock_signals (
    owner text NOT NULL,
    source text NOT NULL,
    tz text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT owner_clock_signals_owner_not_empty CHECK ((owner <> ''::text))
);


--
-- Name: proactivity_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE proactivity_settings (
    owner text NOT NULL,
    agent text DEFAULT '*'::text NOT NULL,
    door text DEFAULT '*'::text NOT NULL,
    quiet_start text,
    quiet_end text,
    event_per_door_per_day integer,
    escalation_per_door_per_day integer,
    per_owner_per_day integer,
    dnd boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proactivity_settings_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT proactivity_settings_quiet_end_check CHECK ((quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text)),
    CONSTRAINT proactivity_settings_quiet_start_check CHECK ((quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))
);


--
-- Name: ratchet; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE ratchet (
    agent text NOT NULL,
    capability text NOT NULL,
    action text DEFAULT ''::text NOT NULL,
    level text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ratchet_level_check CHECK ((level = ANY (ARRAY['autonomous'::text, 'gated'::text, 'never'::text])))
);


--
-- Name: ratchet_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE ratchet_audit (
    id bigint NOT NULL,
    agent text NOT NULL,
    capability text NOT NULL,
    action text NOT NULL,
    old_level text,
    new_level text,
    changed_by text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ratchet_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE ratchet_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ratchet_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE ratchet_audit_id_seq OWNED BY ratchet_audit.id;


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent text NOT NULL,
    owner text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    recurrence text,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    CONSTRAINT reminders_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT reminders_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'cancelled'::text, 'failed'::text])))
);


--
-- Name: repairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE repairs (
    kind text NOT NULL,
    ref text NOT NULL,
    severity text NOT NULL,
    what text NOT NULL,
    how_to_fix text,
    breaks_in text,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT repairs_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text]))),
    CONSTRAINT repairs_short_text CHECK (((length(kind) <= 64) AND (length(ref) <= 128) AND (length(what) <= 400) AND ((how_to_fix IS NULL) OR (length(how_to_fix) <= 400)) AND ((breaks_in IS NULL) OR (length(breaks_in) <= 64)))),
    CONSTRAINT repairs_what_not_empty CHECK ((length(btrim(what)) > 0))
);


--
-- Name: schedule_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE schedule_settings (
    owner text NOT NULL,
    schedule text NOT NULL,
    hours integer[] NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedule_settings_hours_check CHECK ((((cardinality(hours) >= 1) AND (cardinality(hours) <= 6)) AND (hours <@ ARRAY[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]))),
    CONSTRAINT schedule_settings_owner_not_empty CHECK ((owner <> ''::text)),
    CONSTRAINT schedule_settings_schedule_check CHECK ((schedule ~ '^[a-z0-9-]+$'::text))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent text NOT NULL,
    door text NOT NULL,
    thread_ref text NOT NULL,
    sdk_session text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    task_state jsonb
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: settings_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE settings_audit (
    id bigint NOT NULL,
    key text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    changed_by text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: settings_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE settings_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: settings_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE settings_audit_id_seq OWNED BY settings_audit.id;


--
-- Name: telegram_daily_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE telegram_daily_log (
    chat_id text NOT NULL,
    role text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    principal text NOT NULL,
    CONSTRAINT telegram_daily_log_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: telegram_session_rotation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE telegram_session_rotation (
    chat_id text NOT NULL,
    local_day text NOT NULL,
    pending_context text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    principal text NOT NULL,
    session_id text,
    session_day text,
    handover_day text
);


--
-- Name: trigger_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE trigger_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent text NOT NULL,
    name text NOT NULL,
    cron text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: update_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE update_history (
    id bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    from_release text,
    to_release text NOT NULL,
    images jsonb NOT NULL,
    snapshot_id text,
    outcome text DEFAULT 'started'::text NOT NULL,
    detail text,
    CONSTRAINT update_history_detail_check CHECK (((detail IS NULL) OR (length(detail) <= 400))),
    CONSTRAINT update_history_images_are_digests CHECK (update_history_images_are_digests(images)),
    CONSTRAINT update_history_outcome_check CHECK ((outcome = ANY (ARRAY['started'::text, 'ok'::text, 'failed'::text, 'rolled-back'::text]))),
    CONSTRAINT update_history_to_release_check CHECK ((to_release <> ''::text))
);


--
-- Name: update_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE update_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: update_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE update_history_id_seq OWNED BY update_history.id;


--
-- Name: user_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE user_aliases (
    system text NOT NULL,
    alias text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE users (
    id text NOT NULL,
    display_name text NOT NULL,
    primary_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id text,
    org_role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT users_org_role_check CHECK ((org_role = ANY (ARRAY['owner'::text, 'member'::text, 'restricted'::text])))
);


--
-- Name: voice_exemplar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE voice_exemplar (
    id text NOT NULL,
    lang text NOT NULL,
    text text NOT NULL,
    vector jsonb NOT NULL,
    source_message_id text DEFAULT ''::text NOT NULL,
    included boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mailbox text DEFAULT 'legacy:blended'::text NOT NULL,
    CONSTRAINT voice_exemplar_lang_check CHECK ((lang = ANY (ARRAY['en'::text, 'no'::text])))
);


--
-- Name: voice_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE voice_profile (
    id text DEFAULT 'default'::text NOT NULL,
    core text DEFAULT ''::text NOT NULL,
    notes_en text DEFAULT ''::text NOT NULL,
    notes_no text DEFAULT ''::text NOT NULL,
    model_en text,
    model_no text,
    learn_key text DEFAULT 'chief-of-staff'::text NOT NULL,
    learn_lookback_days integer DEFAULT 365 NOT NULL,
    learn_cap integer DEFAULT 300 NOT NULL,
    proposed jsonb,
    relearn_requested_at timestamp with time zone,
    learn_status text DEFAULT 'idle'::text NOT NULL,
    learn_message text DEFAULT ''::text NOT NULL,
    updated_by text DEFAULT 'system'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_profile_learn_status_check CHECK ((learn_status = ANY (ARRAY['idle'::text, 'running'::text, 'error'::text])))
);


--
-- Name: workflow_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE workflow_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent text NOT NULL,
    principal text,
    workflow_type text NOT NULL,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    step_index integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    due_at timestamp with time zone DEFAULT now() NOT NULL,
    wait_event text,
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_step_at timestamp with time zone,
    correlation_key text,
    CONSTRAINT workflow_jobs_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'waiting'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: agent_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_notes ALTER COLUMN id SET DEFAULT nextval('agent_notes_id_seq'::regclass);


--
-- Name: approval_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY approval_events ALTER COLUMN id SET DEFAULT nextval('approval_events_id_seq'::regclass);


--
-- Name: audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY audit ALTER COLUMN id SET DEFAULT nextval('audit_id_seq'::regclass);


--
-- Name: cross_member_grants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY cross_member_grants ALTER COLUMN id SET DEFAULT nextval('cross_member_grants_id_seq'::regclass);


--
-- Name: cross_member_reads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY cross_member_reads ALTER COLUMN id SET DEFAULT nextval('cross_member_reads_id_seq'::regclass);


--
-- Name: forget_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY forget_ledger ALTER COLUMN id SET DEFAULT nextval('forget_ledger_id_seq'::regclass);


--
-- Name: initiations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY initiations ALTER COLUMN id SET DEFAULT nextval('initiations_id_seq'::regclass);


--
-- Name: keeper_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY keeper_audit ALTER COLUMN id SET DEFAULT nextval('keeper_audit_id_seq'::regclass);


--
-- Name: memory_proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY memory_proposals ALTER COLUMN id SET DEFAULT nextval('memory_proposals_id_seq'::regclass);


--
-- Name: notion_sync_docs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_docs ALTER COLUMN id SET DEFAULT nextval('notion_sync_docs_id_seq'::regclass);


--
-- Name: ratchet_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY ratchet_audit ALTER COLUMN id SET DEFAULT nextval('ratchet_audit_id_seq'::regclass);


--
-- Name: settings_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY settings_audit ALTER COLUMN id SET DEFAULT nextval('settings_audit_id_seq'::regclass);


--
-- Name: update_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY update_history ALTER COLUMN id SET DEFAULT nextval('update_history_id_seq'::regclass);


--
-- Name: agent_avatars agent_avatars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_avatars
    ADD CONSTRAINT agent_avatars_pkey PRIMARY KEY (name);


--
-- Name: agent_conversations agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (agent, incarnation, session_id);


--
-- Name: agent_definitions agent_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_definitions
    ADD CONSTRAINT agent_definitions_pkey PRIMARY KEY (name);


--
-- Name: agent_door_claim_audit agent_door_claim_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_door_claim_audit
    ADD CONSTRAINT agent_door_claim_audit_pkey PRIMARY KEY (id);


--
-- Name: agent_door_connections agent_door_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_door_connections
    ADD CONSTRAINT agent_door_connections_pkey PRIMARY KEY (agent, kind);


--
-- Name: agent_doors agent_doors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_doors
    ADD CONSTRAINT agent_doors_pkey PRIMARY KEY (agent, kind);


--
-- Name: agent_notes agent_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_notes
    ADD CONSTRAINT agent_notes_pkey PRIMARY KEY (id);


--
-- Name: agent_registry agent_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_registry
    ADD CONSTRAINT agent_registry_pkey PRIMARY KEY (name);


--
-- Name: agent_resources agent_resources_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_resources
    ADD CONSTRAINT agent_resources_address_key UNIQUE (address);


--
-- Name: agent_resources agent_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_resources
    ADD CONSTRAINT agent_resources_pkey PRIMARY KEY (name);


--
-- Name: agent_resources agent_resources_workflow_database_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_resources
    ADD CONSTRAINT agent_resources_workflow_database_key UNIQUE (workflow_database);


--
-- Name: approval_asks approval_asks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY approval_asks
    ADD CONSTRAINT approval_asks_pkey PRIMARY KEY (request_id);


--
-- Name: approval_events approval_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY approval_events
    ADD CONSTRAINT approval_events_pkey PRIMARY KEY (id);


--
-- Name: atlas_notes atlas_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY atlas_notes
    ADD CONSTRAINT atlas_notes_pkey PRIMARY KEY (note_path);


--
-- Name: atlas_proposals atlas_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY atlas_proposals
    ADD CONSTRAINT atlas_proposals_pkey PRIMARY KEY (id);


--
-- Name: audit audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY audit
    ADD CONSTRAINT audit_pkey PRIMARY KEY (id);


--
-- Name: backup_status backup_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY backup_status
    ADD CONSTRAINT backup_status_pkey PRIMARY KEY (check_name);


--
-- Name: brief_settings brief_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY brief_settings
    ADD CONSTRAINT brief_settings_pkey PRIMARY KEY (owner);


--
-- Name: clipping_choice clipping_choice_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY clipping_choice
    ADD CONSTRAINT clipping_choice_pkey PRIMARY KEY (id);


--
-- Name: clipping_items clipping_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY clipping_items
    ADD CONSTRAINT clipping_items_pkey PRIMARY KEY (source_id, source_item_id);


--
-- Name: clipping_requests clipping_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY clipping_requests
    ADD CONSTRAINT clipping_requests_pkey PRIMARY KEY (id);


--
-- Name: clipping_sources clipping_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY clipping_sources
    ADD CONSTRAINT clipping_sources_pkey PRIMARY KEY (id);


--
-- Name: confirmations confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY confirmations
    ADD CONSTRAINT confirmations_pkey PRIMARY KEY (id);


--
-- Name: conversation_entries conversation_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY conversation_entries
    ADD CONSTRAINT conversation_entries_pkey PRIMARY KEY (id);


--
-- Name: conversation_retention conversation_retention_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY conversation_retention
    ADD CONSTRAINT conversation_retention_pkey PRIMARY KEY (owner);


--
-- Name: cross_member_grants cross_member_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cross_member_grants
    ADD CONSTRAINT cross_member_grants_pkey PRIMARY KEY (id);


--
-- Name: cross_member_reads cross_member_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cross_member_reads
    ADD CONSTRAINT cross_member_reads_pkey PRIMARY KEY (id);


--
-- Name: deadline_candidates deadline_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY deadline_candidates
    ADD CONSTRAINT deadline_candidates_pkey PRIMARY KEY (owner, thread_id);


--
-- Name: deadline_settings deadline_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY deadline_settings
    ADD CONSTRAINT deadline_settings_pkey PRIMARY KEY (owner);


--
-- Name: deadlines deadlines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY deadlines
    ADD CONSTRAINT deadlines_pkey PRIMARY KEY (id);


--
-- Name: digest_requests digest_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY digest_requests
    ADD CONSTRAINT digest_requests_pkey PRIMARY KEY (id);


--
-- Name: digest_skips digest_skips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY digest_skips
    ADD CONSTRAINT digest_skips_pkey PRIMARY KEY (agent, path);


--
-- Name: email_triage_processed email_triage_processed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY email_triage_processed
    ADD CONSTRAINT email_triage_processed_pkey PRIMARY KEY (mailbox, gmail_message_id);


--
-- Name: email_watch_cursors email_watch_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY email_watch_cursors
    ADD CONSTRAINT email_watch_cursors_pkey PRIMARY KEY (watcher, principal, email_address);


--
-- Name: forget_ledger forget_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY forget_ledger
    ADD CONSTRAINT forget_ledger_pkey PRIMARY KEY (id);


--
-- Name: heartbeat heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY heartbeat
    ADD CONSTRAINT heartbeat_pkey PRIMARY KEY (agent);


--
-- Name: initiations initiations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY initiations
    ADD CONSTRAINT initiations_pkey PRIMARY KEY (id);


--
-- Name: keeper_audit keeper_audit_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY keeper_audit
    ADD CONSTRAINT keeper_audit_operation_id_key UNIQUE (operation_id);


--
-- Name: keeper_audit keeper_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY keeper_audit
    ADD CONSTRAINT keeper_audit_pkey PRIMARY KEY (id);


--
-- Name: keeper_credentials keeper_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY keeper_credentials
    ADD CONSTRAINT keeper_credentials_pkey PRIMARY KEY (slot);


--
-- Name: meeting_followup_sent meeting_followup_sent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY meeting_followup_sent
    ADD CONSTRAINT meeting_followup_sent_pkey PRIMARY KEY (notion_page_id);


--
-- Name: memory_proposals memory_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY memory_proposals
    ADD CONSTRAINT memory_proposals_pkey PRIMARY KEY (id);


--
-- Name: memory_reads memory_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY memory_reads
    ADD CONSTRAINT memory_reads_pkey PRIMARY KEY (session_id, turn_id, kind, ref);


--
-- Name: memory_use memory_use_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY memory_use
    ADD CONSTRAINT memory_use_pkey PRIMARY KEY (kind, ref, owner);


--
-- Name: notion_sync_docs notion_sync_docs_notion_page_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_docs
    ADD CONSTRAINT notion_sync_docs_notion_page_id_key UNIQUE (notion_page_id);


--
-- Name: notion_sync_docs notion_sync_docs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_docs
    ADD CONSTRAINT notion_sync_docs_pkey PRIMARY KEY (id);


--
-- Name: notion_sync_docs notion_sync_docs_vault_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_docs
    ADD CONSTRAINT notion_sync_docs_vault_path_key UNIQUE (vault_path);


--
-- Name: notion_sync_fidelity notion_sync_fidelity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_fidelity
    ADD CONSTRAINT notion_sync_fidelity_pkey PRIMARY KEY (vault_path);


--
-- Name: notion_sync_proposals notion_sync_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_proposals
    ADD CONSTRAINT notion_sync_proposals_pkey PRIMARY KEY (id);


--
-- Name: notion_sync_run notion_sync_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY notion_sync_run
    ADD CONSTRAINT notion_sync_run_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_principal_provider_email_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY oauth_tokens
    ADD CONSTRAINT oauth_tokens_principal_provider_email_uk UNIQUE (principal, provider, email_address);


--
-- Name: obligation_threads obligation_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY obligation_threads
    ADD CONSTRAINT obligation_threads_pkey PRIMARY KEY (thread_id);


--
-- Name: org_member_policy org_member_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY org_member_policy
    ADD CONSTRAINT org_member_policy_pkey PRIMARY KEY (user_id);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: outreach_threads outreach_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY outreach_threads
    ADD CONSTRAINT outreach_threads_pkey PRIMARY KEY (id);


--
-- Name: outreach_threads outreach_threads_thread_account_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY outreach_threads
    ADD CONSTRAINT outreach_threads_thread_account_uk UNIQUE (thread_id, account);


--
-- Name: outside_tool_pins outside_tool_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY outside_tool_pins
    ADD CONSTRAINT outside_tool_pins_pkey PRIMARY KEY (agent, tool);


--
-- Name: owner_clock_signals owner_clock_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY owner_clock_signals
    ADD CONSTRAINT owner_clock_signals_pkey PRIMARY KEY (owner, source);


--
-- Name: proactivity_settings proactivity_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY proactivity_settings
    ADD CONSTRAINT proactivity_settings_pkey PRIMARY KEY (owner, agent, door);


--
-- Name: ratchet_audit ratchet_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY ratchet_audit
    ADD CONSTRAINT ratchet_audit_pkey PRIMARY KEY (id);


--
-- Name: ratchet ratchet_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY ratchet
    ADD CONSTRAINT ratchet_pkey PRIMARY KEY (agent, capability, action);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: repairs repairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY repairs
    ADD CONSTRAINT repairs_pkey PRIMARY KEY (kind, ref);


--
-- Name: schedule_settings schedule_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY schedule_settings
    ADD CONSTRAINT schedule_settings_pkey PRIMARY KEY (owner, schedule);


--
-- Name: sessions sessions_agent_door_thread_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_agent_door_thread_ref_key UNIQUE (agent, door, thread_ref);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: settings_audit settings_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY settings_audit
    ADD CONSTRAINT settings_audit_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: telegram_session_rotation telegram_session_rotation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY telegram_session_rotation
    ADD CONSTRAINT telegram_session_rotation_pkey PRIMARY KEY (chat_id);


--
-- Name: trigger_schedules trigger_schedules_agent_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY trigger_schedules
    ADD CONSTRAINT trigger_schedules_agent_name_key UNIQUE (agent, name);


--
-- Name: trigger_schedules trigger_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY trigger_schedules
    ADD CONSTRAINT trigger_schedules_pkey PRIMARY KEY (id);


--
-- Name: update_history update_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY update_history
    ADD CONSTRAINT update_history_pkey PRIMARY KEY (id);


--
-- Name: user_aliases user_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY user_aliases
    ADD CONSTRAINT user_aliases_pkey PRIMARY KEY (system, alias);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: voice_exemplar voice_exemplar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY voice_exemplar
    ADD CONSTRAINT voice_exemplar_pkey PRIMARY KEY (mailbox, id);


--
-- Name: voice_profile voice_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY voice_profile
    ADD CONSTRAINT voice_profile_pkey PRIMARY KEY (id);


--
-- Name: workflow_jobs workflow_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY workflow_jobs
    ADD CONSTRAINT workflow_jobs_pkey PRIMARY KEY (id);


--
-- Name: agent_conversations_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversations_recent ON agent_conversations USING btree (agent, incarnation, observed_at DESC);


--
-- Name: agent_notes_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_notes_owner_idx ON agent_notes USING btree (owner, at DESC, id DESC);


--
-- Name: agent_notes_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_notes_session_idx ON agent_notes USING btree (session_id, id);


--
-- Name: approval_asks_call_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approval_asks_call_idx ON approval_asks USING btree (call_id);


--
-- Name: approval_asks_tool_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_asks_tool_idx ON approval_asks USING btree (agent, tool, asked_at DESC);


--
-- Name: approval_events_call_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approval_events_call_idx ON approval_events USING btree (call_id) WHERE (call_id IS NOT NULL);


--
-- Name: approval_events_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_events_key_idx ON approval_events USING btree (agent, capability, at DESC);


--
-- Name: atlas_notes_attention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX atlas_notes_attention_idx ON atlas_notes USING btree (state) WHERE (state <> 'ok'::text);


--
-- Name: atlas_proposals_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX atlas_proposals_open ON atlas_proposals USING btree (note_path) WHERE (state = ANY (ARRAY['pending'::text, 'approved'::text]));


--
-- Name: atlas_proposals_unannounced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX atlas_proposals_unannounced ON atlas_proposals USING btree (created_at) WHERE ((state = 'pending'::text) AND (announced_at IS NULL));


--
-- Name: clipping_items_dup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clipping_items_dup_idx ON clipping_items USING btree (owner, visibility, url_key, first_seen_at DESC) WHERE ((url_key IS NOT NULL) AND (state = ANY (ARRAY['imported'::text, 'filed-unknown'::text])));


--
-- Name: clipping_items_waiting_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clipping_items_waiting_idx ON clipping_items USING btree (source_id, last_checked_at NULLS FIRST) WHERE (state = 'imported'::text);


--
-- Name: clipping_requests_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clipping_requests_queue_idx ON clipping_requests USING btree (status, created_at);


--
-- Name: confirmations_slack_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX confirmations_slack_ref_idx ON confirmations USING btree (slack_channel, slack_ts) WHERE (slack_ts IS NOT NULL);


--
-- Name: conversation_entries_age_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_entries_age_idx ON conversation_entries USING btree (at);


--
-- Name: conversation_entries_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_entries_person_idx ON conversation_entries USING btree (person_key, at DESC);


--
-- Name: conversation_entries_since_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_entries_since_idx ON conversation_entries USING btree (agent, at);


--
-- Name: cross_member_grants_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cross_member_grants_active_idx ON cross_member_grants USING btree (grantor_user_id, capability) WHERE (revoked_at IS NULL);


--
-- Name: cross_member_reads_grantor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cross_member_reads_grantor_idx ON cross_member_reads USING btree (grantor_user_id, read_at DESC);


--
-- Name: deadlines_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deadlines_open_idx ON deadlines USING btree (owner, due_date) WHERE (status = 'open'::text);


--
-- Name: digest_requests_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX digest_requests_pending_idx ON digest_requests USING btree (agent, status);


--
-- Name: email_triage_processed_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_triage_processed_recent_idx ON email_triage_processed USING btree (processed_at);


--
-- Name: email_triage_processed_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_triage_processed_thread_idx ON email_triage_processed USING btree (mailbox, thread_id) WHERE (draft_id IS NOT NULL);


--
-- Name: forget_ledger_one_per_thing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX forget_ledger_one_per_thing_idx ON forget_ledger USING btree (owner, kind, match_hash);


--
-- Name: initiations_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX initiations_day_idx ON initiations USING btree (owner, owner_day, status, cls, door);


--
-- Name: initiations_hold_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX initiations_hold_idx ON initiations USING btree (owner, agent, item_key, until_at DESC) WHERE (status = 'deferred'::text);


--
-- Name: initiations_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX initiations_seen_idx ON initiations USING btree (owner, agent, item_key) WHERE (status = 'sent'::text);


--
-- Name: initiations_suppressed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX initiations_suppressed_idx ON initiations USING btree (owner, agent, item_key, owner_day) WHERE (status = 'suppressed'::text);


--
-- Name: keeper_audit_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX keeper_audit_action_idx ON keeper_audit USING btree (action, at DESC);


--
-- Name: keeper_audit_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX keeper_audit_at_idx ON keeper_audit USING btree (at DESC);


--
-- Name: meeting_followup_sent_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meeting_followup_sent_recent_idx ON meeting_followup_sent USING btree (processed_at);


--
-- Name: meeting_followup_sent_series_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meeting_followup_sent_series_idx ON meeting_followup_sent USING btree (series_key, processed_at DESC) WHERE (outcome = 'sent'::text);


--
-- Name: memory_proposals_add_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memory_proposals_add_open_idx ON memory_proposals USING btree (ref) WHERE ((state = ANY (ARRAY['pending'::text, 'approved'::text])) AND (action = 'add'::text));


--
-- Name: memory_proposals_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memory_proposals_open_idx ON memory_proposals USING btree (existing_id) WHERE ((state = ANY (ARRAY['pending'::text, 'approved'::text])) AND (action <> 'add'::text));


--
-- Name: memory_reads_owner_age_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_reads_owner_age_idx ON memory_reads USING btree (owner, at);


--
-- Name: memory_reads_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_reads_turn_idx ON memory_reads USING btree (session_id, turn_id, at DESC);


--
-- Name: memory_use_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_use_stale_idx ON memory_use USING btree (owner, last_used);


--
-- Name: notion_sync_docs_attention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notion_sync_docs_attention_idx ON notion_sync_docs USING btree (state) WHERE (state <> 'synced'::text);


--
-- Name: notion_sync_proposals_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notion_sync_proposals_open ON notion_sync_proposals USING btree (vault_path) WHERE (state = ANY (ARRAY['pending'::text, 'approved'::text]));


--
-- Name: notion_sync_proposals_unannounced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notion_sync_proposals_unannounced ON notion_sync_proposals USING btree (created_at) WHERE ((state = 'pending'::text) AND (announced_at IS NULL));


--
-- Name: oauth_tokens_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_tokens_provider_idx ON oauth_tokens USING btree (provider);


--
-- Name: obligation_threads_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obligation_threads_open_idx ON obligation_threads USING btree (last_message_at DESC) WHERE (dismissed_at IS NULL);


--
-- Name: outreach_threads_awaiting_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_threads_awaiting_idx ON outreach_threads USING btree (status) WHERE (status = 'awaiting_reply'::text);


--
-- Name: ratchet_audit_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ratchet_audit_key_idx ON ratchet_audit USING btree (agent, capability, id DESC);


--
-- Name: reminders_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_due_idx ON reminders USING btree (status, due_at);


--
-- Name: repairs_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repairs_open_idx ON repairs USING btree (severity, last_seen_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: telegram_daily_log_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_daily_log_chat_idx ON telegram_daily_log USING btree (chat_id, created_at);


--
-- Name: update_history_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX update_history_started_idx ON update_history USING btree (started_at DESC);


--
-- Name: user_aliases_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_aliases_user_idx ON user_aliases USING btree (user_id);


--
-- Name: voice_exemplar_mailbox_included_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_exemplar_mailbox_included_idx ON voice_exemplar USING btree (mailbox, included);


--
-- Name: workflow_jobs_correlation_uk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_jobs_correlation_uk ON workflow_jobs USING btree (agent, workflow_type, correlation_key) WHERE (correlation_key IS NOT NULL);


--
-- Name: workflow_jobs_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_jobs_due_idx ON workflow_jobs USING btree (due_at) WHERE ((wait_event IS NULL) AND (status = ANY (ARRAY['pending'::text, 'waiting'::text])));


--
-- Name: workflow_jobs_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_jobs_event_idx ON workflow_jobs USING btree (agent, wait_event) WHERE (wait_event IS NOT NULL);


--
-- Name: ratchet ratchet_audit_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ratchet_audit_trg AFTER INSERT OR DELETE OR UPDATE ON ratchet FOR EACH ROW EXECUTE FUNCTION ratchet_audit_fn();


--
-- Name: settings settings_audit_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settings_audit_trg AFTER INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION settings_audit_fn();


--
-- Name: agent_avatars agent_avatars_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY agent_avatars
    ADD CONSTRAINT agent_avatars_name_fkey FOREIGN KEY (name) REFERENCES agent_definitions(name) ON DELETE CASCADE;


--
-- Name: clipping_items clipping_items_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY clipping_items
    ADD CONSTRAINT clipping_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES clipping_sources(id) ON DELETE CASCADE;


--
-- Name: confirmations confirmations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY confirmations
    ADD CONSTRAINT confirmations_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;


--
-- Name: cross_member_grants cross_member_grants_grantor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cross_member_grants
    ADD CONSTRAINT cross_member_grants_grantor_user_id_fkey FOREIGN KEY (grantor_user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: org_member_policy org_member_policy_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY org_member_policy
    ADD CONSTRAINT org_member_policy_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: user_aliases user_aliases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY user_aliases
    ADD CONSTRAINT user_aliases_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: users users_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id);

--
-- Name: schema_migrations; Type: TABLE; Schema: public
-- The runner's own ledger. `migrate` creates it before it applies anything (lib/migration-ledger.ts
-- carries the same statements); repeated here so this file alone describes the whole schema.
--

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  number     integer     NOT NULL,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  how        text        NOT NULL,
  took_ms    integer     NOT NULL DEFAULT 0,
  seq        bigserial   NOT NULL,
  CONSTRAINT schema_migrations_how_check CHECK (how IN ('applied', 'adopted'))
);

CREATE INDEX IF NOT EXISTS schema_migrations_seq_idx ON schema_migrations (seq);

--
-- Rows the code expects on a fresh database
--

INSERT INTO voice_profile (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

INSERT INTO backup_status (check_name) VALUES
  ('verify'),
  ('drill')
ON CONFLICT (check_name) DO NOTHING;

INSERT INTO notion_sync_run (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- One row per schedule, plus one tick row for the slot-based schedules. The key is the fixed role
-- name and the schedule's own name. tests/schedule-heartbeat-conformance.test.ts pins this list to
-- the schedule files.
INSERT INTO heartbeat (agent) VALUES
  ('chief-of-staff/clipping-requests'),
  ('chief-of-staff/conversation-prune'),
  ('chief-of-staff/crm-routing'),
  ('chief-of-staff/deadlines'),
  ('chief-of-staff/digest'),
  ('chief-of-staff/dream'),
  ('chief-of-staff/email-triage'),
  ('chief-of-staff/evening-brief'),
  ('chief-of-staff/meeting-followup'),
  ('chief-of-staff/morning-brief'),
  ('chief-of-staff/outreach-reply-watch'),
  ('chief-of-staff/owner-clock'),
  ('chief-of-staff/proposals-watch'),
  ('chief-of-staff/reminders'),
  ('chief-of-staff/reping'),
  ('chief-of-staff/telegram-handover'),
  ('chief-of-staff/voice-learn'),
  ('chief-of-staff/weekly-summary'),
  ('chief-of-staff/morning-brief/tick'),
  ('chief-of-staff/evening-brief/tick'),
  ('chief-of-staff/digest/tick'),
  ('chief-of-staff/dream/tick'),
  ('chief-of-staff/conversation-prune/tick'),
  ('chief-of-staff/voice-learn/tick'),
  ('chief-of-staff/weekly-summary/tick'),
  ('chief-of-staff/crm-routing/tick'),
  ('chief-of-staff/telegram-handover/tick')
ON CONFLICT (agent) DO NOTHING;

COMMIT;
