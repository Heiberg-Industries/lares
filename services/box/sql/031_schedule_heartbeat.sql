-- 031_schedule_heartbeat.sql — ORB-175. Every eve-saga schedule stamps a `heartbeat` row on a
-- completed pass (and the slot-based ones on every completed tick), so a schedule that stops
-- running is visible as a row that stops aging forward — the digest ran nowhere for ten days
-- (2026-08-21 → 31) and nothing could see it, because a filed-0 pass left no durable trace.
--
-- The table existed on the box only because the OLD runtime created it at boot
-- (services/agent-runtime/lib/adapters/heartbeat.ts); declared here so a fresh install has it.
--
-- SEEDED AT `now()` ON PURPOSE. The clock starts at install: a row that is never stamped again
-- turns stale after its schedule's threshold, so a fresh Lares install is green on day one and
-- red the first time a schedule misses its window. `input-freshness.sh` still treats an ABSENT
-- row as stale (ORB-179's rule) — that is what catches "the migration was never applied".
--
-- The digest's ORB-179 row `saga-digest` is renamed to the new key shape; its age carries over.
-- Hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS heartbeat (
  agent      text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now()
);

UPDATE heartbeat SET agent = 'saga/digest'
 WHERE agent = 'saga-digest'
   AND NOT EXISTS (SELECT 1 FROM heartbeat WHERE agent = 'saga/digest');

INSERT INTO heartbeat (agent) VALUES
  ('saga/morning-brief'),
  ('saga/evening-brief'),
  ('saga/digest'),
  ('saga/dream'),
  ('saga/voice-learn'),
  ('saga/weekly-summary'),
  ('saga/crm-routing'),
  ('saga/email-triage'),
  ('saga/meeting-followup'),
  ('saga/outreach-reply-watch'),
  ('saga/proposals-watch'),
  ('saga/reminders'),
  ('saga/reping'),
  ('saga/morning-brief/tick'),
  ('saga/evening-brief/tick'),
  ('saga/digest/tick'),
  ('saga/dream/tick'),
  ('saga/voice-learn/tick'),
  ('saga/weekly-summary/tick'),
  ('saga/crm-routing/tick')
ON CONFLICT (agent) DO NOTHING;

COMMIT;
