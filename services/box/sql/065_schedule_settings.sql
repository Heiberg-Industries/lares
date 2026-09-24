-- 065_schedule_settings.sql — LAR-17-s1. Groundwork so "when do the agents speak" becomes a
-- setting, not a code constant: one row per (owner, schedule), holding the whole-hour slot list a
-- schedule fires on. Styled like `deadline_settings` in sql/036.
--
-- Numbered 065, not 052 as LAR-17's own plan names it: another workstream owns 060-062, and this
-- installation's migration runner refuses a file numbered below the highest one already applied.
--
-- `schedule` is constrained on SHAPE (`^[a-z0-9-]+$`), not an enumerated list — adding a schedule
-- later must never need a migration. The table of known schedule keys and their default hours
-- lives in code: `packages/agent-kit/src/schedule-settings.ts`'s `SCHEDULE_HOUR_DEFAULTS`.
--
-- Whole hours only (0-23): the owner's decision of 2026-09-18 is that half-hours are out of scope,
-- since every slot schedule fires on minute 0 by design. `hours` allows up to 6 slots a day, which
-- covers every owner-facing schedule today (the widest is three, for CRM routing).
--
-- No seed row. An installation with no row here reads the kit's default, which reproduces today's
-- behaviour exactly (Bendik's box keeps its current times as its "settings").
--
-- Self-contained — it references no other table — so the image probe, which applies every
-- migration from 039 up to a hand-built database, applies this cleanly on its own.
-- Hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS schedule_settings (
  owner       text NOT NULL,
  schedule    text NOT NULL CHECK (schedule ~ '^[a-z0-9-]+$'),
  hours       integer[] NOT NULL CHECK (
                cardinality(hours) BETWEEN 1 AND 6
                AND hours <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]
              ),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, schedule)
);

COMMIT;
