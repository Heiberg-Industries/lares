/**
 * lib/owner-clock.ts — Marcel's cached answer to "what time is it where Bendik is" (ORB-193).
 *
 * The resolution itself lives in the kit (`@lares/agent-kit/owner-clock`), one implementation for
 * every agent, and this is the SERVICE's wiring around it — the mirror of
 * `services/chief-of-staff/lib/owner-clock.ts`, with two deliberate differences:
 *
 * 1. **Marcel IS the trip source.** `MARCEL_DATA_ROOT`'s `config.json` is the file the kit's
 *    resolver reads (`loadOwnerClockTrips`), and it is the same file `lib/trip-store.ts` writes.
 *    Saga reads Marcel's mount to get this answer; here it is simply local.
 * 2. **There is NO Slack-profile source.** Marcel holds no Slack token and never writes an
 *    `owner_clock_signals` row, so no database is handed to the resolver at all: the chain is
 *    trip → home. (Saga refreshes that signal every 30 minutes; if Marcel ever needed it, the
 *    only change here would be passing a pool.)
 *
 * Two properties carried over from Saga's file because they are the reason it exists:
 *
 * - **The env is read per call, never at module scope.** `eve build` evaluates this module with no
 *   environment at all, so `MARCEL_DATA_ROOT`, `OWNER_HOME_TZ` and `AGENT_OWNER_USER_ID` are
 *   looked up inside the resolve.
 * - **It cannot fail loudly.** A clock failure that propagates takes a tick with it, which is the
 *   ORB-179 shape (ten silent dead days). Every failure returns the home timezone and logs ONCE
 *   per failure spell — the lifecycle schedule ticks every minute, so a per-call log line would
 *   be its own outage.
 *
 * NOT the same thing as `TripStore.homeTimezone()` / `postingTimezone()` in
 * `lib/trip-schedule.ts`. Those decide when a POST is due (and keep their own finer arrival
 * logic, per the plan's Ruling 1); this decides which clock the GATE judges quiet hours on. They
 * agree during a trip, which is the point.
 */
import {
  DEFAULT_HOME_TZ,
  resolveOwnerClock,
  type OwnerClock,
} from "@lares/agent-kit/owner-clock";

import { ownerId } from "./principals.js";

/** How long a resolved clock is served from memory. Five minutes, as in eve-saga: a timezone
 *  changes a handful of times a year, and the cost of being wrong for one window is one slot
 *  judged on the previous clock, five minutes off. */
export const OWNER_TZ_CACHE_MS = 5 * 60_000;

// The owner this service speaks for lives in `lib/principals.ts` as `ownerId()` — ONE export, not
// two names for one env var (the same fix eve-saga's own owner-clock.ts records). `initiations.owner`
// and `proactivity_settings.owner` are that same key, and the clock and the ledger disagreeing about
// whose day it is would be invisible until a quiet-hours window silently applied to nobody.

/** The configured home clock — the floor every other source falls back to. The one env-only knob
 *  ORB-193 introduces (shown read-only on the console's proactivity page). */
export function homeTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return env["OWNER_HOME_TZ"]?.trim() || DEFAULT_HOME_TZ;
}

/** The trip store the kit's resolver reads its date windows from — Marcel's own data root. */
export function tripsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["MARCEL_DATA_ROOT"]?.trim() || undefined;
}

export interface CachedOwnerClock {
  clock(): Promise<OwnerClock>;
  tz(): Promise<string>;
}

export interface CachedOwnerClockOptions {
  resolve: (now: Date) => Promise<OwnerClock>;
  homeTz: () => string;
  now?: () => Date;
  ttlMs?: number;
}

/**
 * The cache, as a pure factory over an injected resolver — so the caching, the fail-to-home and
 * the log-once behaviour are testable without a trip store or a clock.
 *
 * In-flight requests are shared (`pending`), not just completed ones: a tick can ask for several
 * posts at once, and a per-caller resolve would turn one cheap file read into a small stampede.
 */
export function makeCachedOwnerClock(opts: CachedOwnerClockOptions): CachedOwnerClock {
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlMs ?? OWNER_TZ_CACHE_MS;

  let cached: { at: number; value: OwnerClock } | undefined;
  let pending: Promise<OwnerClock> | undefined;
  let warned = false;

  async function load(): Promise<OwnerClock> {
    const at = now().getTime();
    try {
      const value = await opts.resolve(new Date(at));
      warned = false; // a recovery may warn again next time it breaks
      cached = { at, value };
      return value;
    } catch (err) {
      // The kit's resolver already degrades every source internally (a missing or corrupt
      // config.json is a logged warning and an empty trip list), so reaching here means the
      // wiring itself failed. Home is the answer, and the FALLBACK IS CACHED for the same
      // window: a broken source must not be re-dialled once a minute.
      if (!warned) {
        warned = true;
        console.error(
          `owner-clock: could not resolve the owner clock — using the home timezone ` +
            `(${opts.homeTz()}) for the next ${Math.round(ttl / 60_000)} min`,
          err,
        );
      }
      const value: OwnerClock = {
        tz: opts.homeTz(),
        source: "home",
        detail: "home timezone — the owner clock could not be resolved",
      };
      cached = { at, value };
      return value;
    }
  }

  return {
    async clock() {
      const t = now().getTime();
      if (cached && t - cached.at < ttl) return cached.value;
      if (!pending) {
        pending = load().finally(() => {
          pending = undefined;
        });
      }
      return pending;
    },
    async tz() {
      return (await this.clock()).tz;
    },
  };
}

/** The live instance: Marcel's own trip store, no Slack signal, the canonical owner. */
const live = makeCachedOwnerClock({
  resolve: (now) =>
    resolveOwnerClock({
      now,
      // Read per call — see this file's header.
      ...(tripsDir() ? { tripsDir: tripsDir()! } : {}),
      owner: ownerId(),
      homeTz: homeTimezone(),
    }),
  homeTz: () => homeTimezone(),
});

/** THE call every gated send makes. Never throws. */
export async function ownerTz(): Promise<string> {
  return live.tz();
}

/** The same answer plus which source won and why — for a log line or the console. */
export async function ownerClock(): Promise<OwnerClock> {
  return live.clock();
}
