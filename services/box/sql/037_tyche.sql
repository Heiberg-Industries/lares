-- 037_tyche.sql — LAR-32. The three prediction-market tables the retired agent-runtime's
-- `ensureTycheTables()` created at boot (services/agent-runtime/lib/adapters/tyche/schema.ts,
-- deleted in 03404bc6 / ORB-189). They were hand-applied on the box and no migration has owned
-- them since; Saga's `market-edge` skill, the `market-refresh` schedule (ORB-214) and the
-- console's `/markets` page all read and write them today. Copied verbatim from the DDL in
-- packages/agent-kit/tests/markets-db-integration.test.ts, which is byte-identical to the
-- retired schema.ts. Hand-applied; idempotent; one transaction; a no-op on the box, which
-- already has these tables.
BEGIN;

CREATE TABLE IF NOT EXISTS tyche_markets (
  id                  text        PRIMARY KEY,
  label               text        NOT NULL,
  pm_market_id        text,
  kalshi_event_ticker text,
  outcome_aliases     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  end_date            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  market_type         text        NOT NULL DEFAULT 'mutually_exclusive',
  match_source        text,
  match_checked_at    timestamptz,
  match_result        text,
  match_confidence    real
);

CREATE TABLE IF NOT EXISTS tyche_market_snapshots (
  id         bigserial   PRIMARY KEY,
  market_id  text        NOT NULL,
  outcome_id text        NOT NULL,
  label      text,
  venue      text        NOT NULL,
  bid        numeric,
  ask        numeric,
  mid        numeric,
  liquidity  numeric,
  ts         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tyche_snapshots_lookup
  ON tyche_market_snapshots (market_id, outcome_id, venue, ts DESC);

CREATE TABLE IF NOT EXISTS tyche_alert_state (
  market_id       text        NOT NULL,
  outcome_id      text        NOT NULL,
  last_edge       numeric,
  last_basis      numeric,
  last_alerted_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, outcome_id)
);

-- Re-running this file is safe, but it is NOT a schema reconciler: `CREATE TABLE IF NOT EXISTS`
-- skips an existing table whole, so column defaults land only on a FRESH create, and the index
-- only on its first `CREATE INDEX IF NOT EXISTS`. On a database that already has these tables
-- (the box does), anything added here later must be applied by hand (ALTER TABLE … ADD COLUMN /
-- CREATE INDEX) or shipped as its own numbered migration.

COMMIT;
