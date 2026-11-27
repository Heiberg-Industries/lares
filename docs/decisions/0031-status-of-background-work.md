# ADR 0031 — Background work says where it is: one outcome record, one status part, one way to keep a page up to date

**Date:** 2026-11-27
**Status:** Accepted 2026-11-27, built for Writing style; the other pages follow
**Supersedes:** —
**Amends / reconciles:** nothing. The heartbeat and its monitoring rules (`packages/agent-kit/src/schedule-heartbeat.ts`) are unchanged.

## In plain language

1. Some work in Lares runs in the background: a schedule picks it up a minute later, or at its hour. Until now a console page could not say what happened to it. Pressing "Re-learn from Sent mail" looked dead when the schedule was switched off, because nothing said so.
2. Now each scheduled job records what its last run did: running, finished (with counts), failed (with why), or skipped (with why).
3. The console shows that the same way everywhere, in plain words: Requested, Waiting, Running, Finished, Failed, Skipped. A skip that something can fix links to the switch or setting that fixes it.
4. While something is asked for or running, the page keeps itself up to date and stops once it is done.

## Decision

1. **One record per job, next to the heartbeat, not instead of it.** `schedule_run` (`services/box/sql/041_schedule_run.sql`), keyed like the heartbeat (`<agent>/<schedule>`), holds the last outcome: state, a short reason code for a skip, a plain sentence or an error message, whole-number counts, when it started and when it was recorded. It holds no person data. Written only through `recordRunStarted`, `recordRunFinished`, `recordRunFailed` and `recordRunSkipped`, read through `readScheduleRun` and `readScheduleRuns`, all in `schedule-heartbeat.ts`. Like a stamp, a write never throws and never holds up the run. Its 5 second bound includes the wait for a free database connection: a write whose wait used up the 5 seconds is not made, and one that got its connection late has only the time that is left, so a write the schedule gave up on never lands later over a newer outcome.
2. **One record per agent.** The `<agent>` in an outcome key is the agent's definition name, so a job that more than one agent runs (two chief-of-staff agents on one installation, each learning its own mailbox) has one record per agent, and no agent's outcome replaces another's. Voice learning records under `<agent name>/voice-learn` (`voiceLearnJob` in `voice-learn-outcome.ts`). This is not always the heartbeat's key: the voice-learn heartbeat stays `chief-of-staff/voice-learn` for every agent, as monitoring reads it. A page reads one record per agent and combines them: a run that is going wins, otherwise the newest outcome, named by the agent's display name. Only agents that are not retired count, for the page and for the schedule's check that a run is going: a retired agent's record (retiring does not remove it) is ignored, and so is a record under a key no such agent has.
3. **The heartbeat's rule stays.** A closed gate still stamps no heartbeat, so a dark schedule still pages. A schedule may record a skip with its reason while its gate is closed; that touches only the outcome record.
4. **Reason codes are shared, wording is the console's.** A job's reason codes live in the shared kit beside the job (voice learning: `packages/agent-kit/src/voice-learn-outcome.ts`). The schedule records the code and a plain sentence; the console turns the code into its own sentence and link. An unknown code shows the schedule's sentence.
5. **One status part.** `RunStatus` in `packages/ui/src/patterns.tsx`: a badge, a sentence, and an optional link `{ href, label }`. Its words follow the console's state vocabulary (`services/console/lib/state-colours.ts`) where the two share a state.
6. **One way to keep a page up to date.** `useKeepFresh(active, refresh)` in `services/console/lib/use-keep-fresh.ts` calls `refresh` every 5 seconds while the work is requested, waiting or running, and stops when it is not. A page that fetches its own route (Clipping) and a page that re-reads its server data (Writing style) both use it.
7. **A request is visible from the moment it is made until it ends.** A schedule records the run as started before it clears the request it answers, so a page never sees neither.

## Consequences

- Writing style is the first page on it. The other pages that start background work move to it in a later change, one page at a time.
- A new scheduled job that a person can start or wait for records its outcome with these four calls and names its reason codes in the shared kit.
- The engine has one application database login for every service, so the chief of staff (writes) and the console (reads) share the ordinary grant on `schedule_run`.
