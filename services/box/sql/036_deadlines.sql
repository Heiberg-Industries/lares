-- 036_deadlines.sql — ORB-180 + ORB-214. The standing deadline calendar, the mail-scanner's
-- candidate sightings, and the two settings tables the deadline ladder and market-refresh
-- schedules read: `deadline_settings.ladder_enabled` and `markets_settings.refresh_enabled`,
-- both OFF by default so neither schedule changes behaviour on the day this lands. Hand-applied;
-- idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS deadlines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner          text NOT NULL,
  entity         text NOT NULL,
  title          text NOT NULL,
  source         text NOT NULL CHECK (source IN ('statutory','accounting','contract','subscription','manual')),
  due_date       date NOT NULL,
  recurrence     text NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','yearly','bimonthly','monthly')),
  consequence    text,
  evidence_rule  text NOT NULL DEFAULT 'owner confirms',
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  status_reason  text,
  resolved_at    timestamptz,
  rung           integer NOT NULL DEFAULT 0 CHECK (rung BETWEEN 0 AND 3),
  rung_moved_at  timestamptz,
  rule_key       text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deadlines_open_idx ON deadlines (owner, due_date) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS deadline_candidates (
  owner        text NOT NULL,
  thread_id    text NOT NULL,
  subject      text NOT NULL,
  sender       text NOT NULL,
  seen_at      timestamptz NOT NULL,
  surfaced_at  timestamptz,
  resolution   text CHECK (resolution IN ('added','ignored')),
  PRIMARY KEY (owner, thread_id)
);

CREATE TABLE IF NOT EXISTS deadline_settings (
  owner          text PRIMARY KEY,
  ladder_enabled boolean NOT NULL DEFAULT false,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS markets_settings (
  owner            text PRIMARY KEY,
  refresh_enabled  boolean NOT NULL DEFAULT false,
  watchlist_max    integer NOT NULL DEFAULT 100 CHECK (watchlist_max BETWEEN 10 AND 150),
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Re-running this file is safe, but it is NOT a schema reconciler: `CREATE TABLE IF NOT EXISTS`
-- skips an existing table whole, so the CHECK constraints and column defaults above land only on
-- a FRESH create, and each index only on its first `CREATE INDEX IF NOT EXISTS`. On a database
-- that already has these tables, anything added here later must be applied by hand (ALTER TABLE
-- … ADD CONSTRAINT / CREATE INDEX) or shipped as its own numbered migration.

-- The two new Saga schedules (Tasks 5 and 7) ship their heartbeat rows here, in the same
-- migration as the tables they read — ORB-175's rule.
INSERT INTO heartbeat (agent) VALUES ('saga/deadlines') ON CONFLICT (agent) DO NOTHING;
INSERT INTO heartbeat (agent) VALUES ('saga/market-refresh') ON CONFLICT (agent) DO NOTHING;

COMMIT;
