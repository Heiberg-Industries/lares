-- 070_conversation_prune_heartbeat.sql — the heartbeat rows for the nightly conversation prune
-- (`services/chief-of-staff/agent/schedules/conversation-prune.ts`, ADR-0020 rule 3).
--
-- WHY ITS OWN FILE. ORB-175's rule: sql/031 seeded the original inventory and is already applied
-- on every box, so editing it seeds nothing — a schedule added later ships its rows in its OWN
-- numbered migration (035 did it for `saga/owner-clock`, 036 for two more, 046 for the travel
-- role's four). `services/chief-of-staff/tests/schedule-heartbeat-conformance.test.ts` pins the
-- union of those files against the schedule code, so a row missing here is a red test, not a
-- monitor that quietly watches nothing.
--
-- TWO ROWS, because the prune is slot-based: the pass row moves once a night, and the `/tick` row
-- moves on every completed tick, which is what catches "the process is alive but this schedule's
-- loop died" within 2 h instead of 30.
--
-- SEEDED AT `now()` ON PURPOSE, same reasoning as 031 and 046: the clock starts at install, so a
-- fresh deploy is green on day one and red the first time the schedule misses its window. An
-- ABSENT row still reads as stale in `input-freshness.sh` — that is what catches "the migration
-- was never applied".
--
-- A NOTE FOR WHOEVER READS A STALE ROW HERE: this schedule ships OFF
-- (`packages/agent-kit/templates/chief-of-staff/definition.json`, `{ "on": false }`), and a closed
-- switch stamps nothing. On an installation that has not turned the prune on, a stale
-- `saga/conversation-prune` row is expected and means only that — the same as every other
-- schedule an installation has switched off.
--
-- Hand-applied; idempotent; one transaction.
BEGIN;

INSERT INTO heartbeat (agent) VALUES
  ('saga/conversation-prune'),
  ('saga/conversation-prune/tick')
ON CONFLICT (agent) DO NOTHING;

COMMIT;
