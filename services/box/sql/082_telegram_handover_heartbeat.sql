-- 082_telegram_handover_heartbeat.sql — the heartbeat rows for the nightly Telegram hand-over
-- (`services/chief-of-staff/agent/schedules/telegram-handover.ts`).
--
-- WHY ITS OWN FILE. ORB-175's rule: sql/031 seeded the original inventory and is already applied
-- on every box, so editing it seeds nothing — a schedule added later ships its rows in its OWN
-- numbered migration (035 did it for `saga/owner-clock`, 036 for two more, 046 for the travel
-- role's four, 070 for the conversation prune).
-- `services/chief-of-staff/tests/schedule-heartbeat-conformance.test.ts` pins the union of those
-- files against the schedule code, so a row missing here is a red test, not a monitor that
-- quietly watches nothing.
--
-- TWO ROWS, because the hand-over is slot-based: the pass row moves once a night (00:00 on the
-- owner's clock), and the `/tick` row moves on every completed tick, which is what catches "the
-- process is alive but this schedule's loop died" within 2 h instead of 30.
--
-- SEEDED AT `now()` ON PURPOSE, same reasoning as 031, 046 and 070: the clock starts at install,
-- so a fresh deploy is green on day one and red the first time the schedule misses its window.
-- An ABSENT row still reads as stale in `input-freshness.sh` — that is what catches "the
-- migration was never applied".
--
-- UNLIKE 070, THIS SCHEDULE IS ON BY DEFAULT (it restores what the owner had before the eve
-- upgrade, it deletes nothing and it sends nobody anything), so it carries a line in
-- `services/box/ops/input-freshness.sh` and a stale row here means what it says: the nightly
-- hand-over has stopped running, and the first message of each day is back to being answered
-- without yesterday.
--
-- `heartbeat` is created by sql/031. Hand-applied; idempotent; one transaction.
BEGIN;

INSERT INTO heartbeat (agent) VALUES
  ('saga/telegram-handover'),
  ('saga/telegram-handover/tick')
ON CONFLICT (agent) DO NOTHING;

COMMIT;
