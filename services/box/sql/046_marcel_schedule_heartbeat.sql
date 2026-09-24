-- 046_marcel_schedule_heartbeat.sql — LAR-44, the ORB-175 helper's second step. Marcel's four
-- schedules (`services/travel/agent/schedules/{dream,proximity,taste-promote,trip-lifecycle}.ts`)
-- now stamp the same `heartbeat` table Saga's schedules seed in sql/031_schedule_heartbeat.sql —
-- one shared table, one shared box script, a second agent's rows.
--
-- SEEDED AT `now()` ON PURPOSE, same reasoning as 031: the clock starts at install, so a fresh
-- deploy of this migration is green on day one and red the first time a schedule misses its
-- window. `input-freshness.sh` still treats an ABSENT row as stale — that is what catches "the
-- migration was never applied".
--
-- Hand-applied; idempotent; one transaction.
BEGIN;

INSERT INTO heartbeat (agent) VALUES
  ('marcel/trip-lifecycle'),
  ('marcel/dream'),
  ('marcel/proximity'),
  ('marcel/taste-promote'),
  ('marcel/dream/tick')
ON CONFLICT (agent) DO NOTHING;

COMMIT;
