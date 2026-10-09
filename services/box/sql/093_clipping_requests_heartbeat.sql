-- 093_clipping_requests_heartbeat.sql — the heartbeat row for the clipping request drain
-- (`services/chief-of-staff/agent/schedules/clipping-requests.ts`, LAR-113 child b).
--
-- WHY ITS OWN FILE. Same rule as 070 and 082: sql/031 seeded the original inventory and is already
-- applied everywhere, and 092 (the request queue's tables) only creates new tables. A schedule
-- added later ships its heartbeat row in its OWN numbered migration;
-- `services/chief-of-staff/tests/schedule-heartbeat-conformance.test.ts` pins the union of those
-- files against the schedule code.
--
-- ONE ROW: the drain polls every minute, so its pass row is its tick (no `/tick` row).
-- SEEDED AT `now()` ON PURPOSE, as in 031, 070 and 082: a fresh deploy is green on day one and red
-- the first time the drain misses its window. An ABSENT row still reads as stale in
-- `input-freshness.sh`, which is what catches "the migration was never applied".
--
-- `heartbeat` is created by sql/031. Hand-applied; idempotent; one transaction.
BEGIN;

INSERT INTO heartbeat (agent) VALUES
  ('saga/clipping-requests')
ON CONFLICT (agent) DO NOTHING;

COMMIT;
