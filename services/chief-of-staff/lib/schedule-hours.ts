/**
 * lib/schedule-hours.ts — LAR-17-s2/s3/s4. A small in-process cache in front of
 * `@lares/agent-kit/schedule-settings`'s `readScheduleHours`, for the slot schedules that poll
 * every minute.
 *
 * WHY A CACHE: resolving fresh on every tick would mean a `SELECT` per minute per schedule — up to
 * ~10,000 reads a day across seven schedules — for an answer that changes only when the owner
 * edits it in the console, at most a handful of times a year. Same shape as `lib/owner-clock.ts`'s
 * own cache (`makeCachedOwnerClock`), for the same reason, and this follows its pattern: a pure
 * factory over an injected reader, so the TTL and caching behaviour are testable without a
 * database.
 *
 * WHAT THE TTL MEANS FOR THE OWNER: a change saved in the console takes effect within
 * `SCHEDULE_HOURS_CACHE_MS` (five minutes) — never instantly, and never RETROACTIVELY. A slot that
 * has already fired today under the OLD hour stays fired: the ledger's already-seen rule holds it
 * by item key, and `lib/initiation.ts`'s `alreadySentToday` holds it a second way for the two
 * briefs (see that function's own doc-comment for why a second guard exists at all). Only a slot
 * still AHEAD of `now` can move onto a new hour, and only once the cache has refreshed.
 *
 * `readScheduleHours` is already failure-proof on its own (a missing table, an invalid stored
 * value or a query failure all resolve to the schedule's engine default with one warning, and it
 * never throws) — this cache adds nothing to that contract beyond the TTL, so a schedule reading
 * through it keeps the same "a settings read must never stop a brief" guarantee.
 */
import { getPool } from "@lares/agent-kit/db";
import { readScheduleHours } from "@lares/agent-kit/schedule-settings";
import { ownerId } from "./principals.js";

/** Five minutes — a schedule's hour changes a handful of times a year at most, and the cost of
 *  being wrong for one window is a console change landing up to this long after it was saved. */
export const SCHEDULE_HOURS_CACHE_MS = 5 * 60_000;

export interface ScheduleHoursSource {
  hours(schedule: string): Promise<number[]>;
}

export interface ScheduleHoursCacheOptions {
  read: (schedule: string) => Promise<number[]>;
  now?: () => Date;
  ttlMs?: number;
}

/**
 * The cache, as a pure factory over an injected reader — matching `lib/owner-clock.ts`'s
 * `makeCachedOwnerClock`. In-flight requests for the SAME schedule are shared, not just completed
 * ones: several call sites can ask within the same tick (or two schedules can share a process),
 * and a per-caller read would turn one cheap lookup into a small stampede against the same row.
 */
export function makeScheduleHoursCache(opts: ScheduleHoursCacheOptions): ScheduleHoursSource {
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlMs ?? SCHEDULE_HOURS_CACHE_MS;

  const cached = new Map<string, { at: number; hours: number[] }>();
  const pending = new Map<string, Promise<number[]>>();

  return {
    async hours(schedule: string): Promise<number[]> {
      const at = now().getTime();
      const hit = cached.get(schedule);
      if (hit && at - hit.at < ttl) return hit.hours;

      let p = pending.get(schedule);
      if (!p) {
        p = opts.read(schedule)
          .then((hours) => {
            cached.set(schedule, { at, hours });
            return hours;
          })
          .finally(() => { pending.delete(schedule); });
        pending.set(schedule, p);
      }
      return p;
    },
  };
}

/** The live instance: this service's pool, the canonical owner, the kit's reader. */
const live = makeScheduleHoursCache({
  read: (schedule) => readScheduleHours(getPool(), ownerId(), schedule),
});

/**
 * THE call every slot schedule makes for its hour(s) — see the module header for what the cache
 * means for the owner. Never throws for a known schedule name (`readScheduleHours` itself never
 * throws — see its own doc-comment); an unknown name is a programmer error and still throws
 * immediately, exactly as `readScheduleHours` does.
 */
export async function scheduleHours(schedule: string): Promise<number[]> {
  return live.hours(schedule);
}
