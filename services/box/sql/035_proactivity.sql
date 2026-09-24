-- 035_proactivity.sql — ORB-193. The proactivity contract's two tables and the owner-clock signal row.
-- Every proactive message passes @lares/agent-kit's gate; the LEDGER is the dedupe key, the daily
-- counter, the escalation rung and the audit trail the console shows. Settings hold what an owner
-- may turn (quiet hours, DND, ceilings LOWERED below the engine defaults); the engine defaults live
-- in code and are the ceiling of the ceiling. Hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS proactivity_settings (
  owner        text NOT NULL,
  agent        text NOT NULL DEFAULT '*',      -- '*' = every agent
  door         text NOT NULL DEFAULT '*',      -- '*' = every door
  -- "HH:MM" in the owner clock; NULL = engine default. The CHECK exists because a malformed value
  -- reaches the gate as NaN minutes, and every comparison against NaN is false — quiet hours would
  -- silently vanish at every hour of the day. The kit validates on read as well (belt and braces).
  quiet_start  text CHECK (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end    text CHECK (quiet_end   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  event_per_door_per_day      integer,         -- NULL = engine default; a value ABOVE the engine default is clamped on read
  escalation_per_door_per_day integer,
  per_owner_per_day           integer,
  dnd          boolean NOT NULL DEFAULT false,
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, agent, door)
);

CREATE TABLE IF NOT EXISTS initiations (
  id          bigserial PRIMARY KEY,
  owner       text NOT NULL,
  agent       text NOT NULL,
  door        text NOT NULL,
  cls         text NOT NULL CHECK (cls IN ('scheduled','event','escalation')),
  item_key    text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent','suppressed','deferred')),
  reason      text,                            -- suppress/defer reason; NULL when sent
  until_at    timestamptz,                     -- deferred: when it may be reconsidered
  owner_day   date NOT NULL,                   -- the owner-clock calendar day the decision belongs to
  decided_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz                      -- set with status='sent', after the confirmed send
);
CREATE INDEX IF NOT EXISTS initiations_seen_idx ON initiations (owner, agent, item_key) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS initiations_day_idx  ON initiations (owner, owner_day, status, cls, door);
-- The hold lookup every gated send makes first: "is this item already serving a deferral?"
CREATE INDEX IF NOT EXISTS initiations_hold_idx ON initiations (owner, agent, item_key, until_at DESC) WHERE status = 'deferred';
-- Its twin for the other shape of a long hold: "have I already suppressed this item today?" The gate
-- reuses a same-day 'dnd'/'quiet-hours' row instead of writing one per tick, so a do-not-disturb
-- spell costs ONE row per item per owner day rather than ~1,440.
CREATE INDEX IF NOT EXISTS initiations_suppressed_idx ON initiations (owner, agent, item_key, owner_day) WHERE status = 'suppressed';

-- Re-running this file is safe, but it is NOT a schema reconciler: `CREATE TABLE IF NOT EXISTS` skips
-- an existing table whole, so the two CHECK constraints above land only on a FRESH create, and each
-- index only on its first `CREATE INDEX IF NOT EXISTS`. On a database that already has these tables,
-- a constraint or index added here later must be applied by hand (ALTER TABLE … ADD CONSTRAINT /
-- CREATE INDEX) or shipped as its own numbered migration.

CREATE TABLE IF NOT EXISTS owner_clock_signals (
  owner       text NOT NULL,
  source      text NOT NULL,                   -- 'slack-profile' (v1); 'calendar' later
  tz          text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, source)
);

-- ORB-175: the new Saga schedule that refreshes the Slack-profile signal ships with its heartbeat row.
INSERT INTO heartbeat (agent) VALUES ('saga/owner-clock') ON CONFLICT (agent) DO NOTHING;

COMMIT;
