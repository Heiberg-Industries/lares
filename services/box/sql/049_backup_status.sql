-- 049_backup_status.sql — LAR-54-s2. `backup-verify.sh`'s nightly verdict, recorded so the
-- console can eventually say whether last night's backup was really verified without reading
-- journalctl on the box. A later slice adds a 'drill' row for the monthly rehearsed restore;
-- both check names are declared and seeded now, so a fresh install can tell "never recorded"
-- (both columns NULL) apart from "recorded and currently failing" (ok = false) from day one —
-- the same "seed at install" reasoning sql/031 and sql/046 give for the heartbeat table.
--
-- ok/checked_at/last_pass_at/detail/target are left NULL by the seed on purpose: an
-- installation that has never run the check should read as unproven, not as a false pass.
--
-- Hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS backup_status (
  check_name   text PRIMARY KEY CHECK (check_name IN ('verify', 'drill')),
  ok           boolean,
  checked_at   timestamptz,
  last_pass_at timestamptz,
  detail       text,
  target       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO backup_status (check_name) VALUES
  ('verify'),
  ('drill')
ON CONFLICT (check_name) DO NOTHING;

COMMIT;
