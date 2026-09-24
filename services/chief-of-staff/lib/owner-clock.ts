/**
 * lib/owner-clock.ts — Saga's cached answer to "what time is it where Bendik is" (ORB-193).
 *
 * The resolution itself lives in the kit (`@lares/agent-kit/owner-clock`): trip → Slack profile →
 * home, one implementation for every agent. This file is the SERVICE's wiring around it, and it
 * exists for three reasons that all point the same way:
 *
 * 1. **It is read on every turn and on every tick.** `agent/instructions/clock.ts` renders the
 *    per-turn clock block; Task 3 puts all seven slot schedules on it too, and the busiest of those
 *    fire every minute. Resolving from scratch each time would mean a `config.json` read and a
 *    `SELECT` per turn, for an answer that changes at most a few times a year. Hence the 5-minute
 *    cache: worst case, a trip's first slot of the day fires on the previous clock, five minutes
 *    early or late once.
 * 2. **The env is read per call, never at module scope.** `eve build` evaluates this module with no
 *    environment at all (the same trap `lib/travel-store.ts` names), so `TRAVEL_PATH`,
 *    `OWNER_HOME_TZ` and `AGENT_OWNER_USER_ID` are looked up inside the resolve.
 * 3. **It cannot fail loudly.** A clock failure that propagates takes a turn or a schedule with it,
 *    which is the ORB-179 shape (ten silent dead days). Every failure here returns the home
 *    timezone and logs ONCE per failure spell — this runs on every message she answers, so a
 *    per-call log line would be its own outage.
 */
import { getPool } from "@lares/agent-kit/db";
import {
  DEFAULT_HOME_TZ,
  resolveOwnerClock,
  type OwnerClock,
} from "@lares/agent-kit/owner-clock";
import { ownerId } from "./principals.js";

/** How long a resolved clock is served from memory. Five minutes: a timezone changes a handful of
 *  times a year, and the cost of being wrong for one window is one slot fired five minutes off. */
export const OWNER_TZ_CACHE_MS = 5 * 60_000;

// The owner this service speaks for lives in `lib/principals.ts` as `ownerId()` — ONE export, not
// two names for one env var (fix round 1). `owner_clock_signals.owner`, `initiations.owner` and
// `proactivity_settings.owner` are all that same key, and the clock and the ledger disagreeing about
// whose day it is would be invisible until a quiet-hours window silently applied to nobody.

/** The configured home clock — the floor every other source falls back to. The one env-only knob
 *  ORB-193 introduces (shown read-only on the console's proactivity page). */
export function homeTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return env["OWNER_HOME_TZ"]?.trim() || DEFAULT_HOME_TZ;
}

export interface CachedOwnerClock {
  clock(): Promise<OwnerClock>;
  tz(): Promise<string>;
  /**
   * The last resolved timezone, WITHOUT waiting — for the one kind of caller that cannot await:
   * eve's approval-card rendering, which the patch calls inline (see `@lares/agent-kit`'s
   * `registerApprovalSummary`). Returns the home timezone until the first resolve has landed and
   * kicks one off, so the second card of a session is already on the owner's clock. Stale by at most
   * the cache TTL, which is the same staleness every other caller already accepts.
   */
  tzSync(): string;
}

export interface CachedOwnerClockOptions {
  resolve: (now: Date) => Promise<OwnerClock>;
  homeTz: () => string;
  now?: () => Date;
  ttlMs?: number;
}

/**
 * The cache, as a pure factory over an injected resolver — so the caching, the fail-to-home and the
 * log-once behaviour are testable without a database, a trip store or a clock.
 *
 * In-flight requests are shared (`pending`), not just completed ones: on a busy tick several
 * schedules and a turn can ask within the same millisecond, and a per-caller resolve would turn one
 * cheap read into a small stampede against the same two sources.
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
      // The kit's resolver already degrades every source internally, so reaching here means the
      // wiring itself failed (no pool, a bad env). Home is the answer, and the FALLBACK IS CACHED
      // for the same window: a dead database must not be re-dialled once per turn.
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

  const api: CachedOwnerClock = {
    async clock() {
      const t = now().getTime();
      if (cached && t - cached.at < ttl) return cached.value;
      if (!pending) {
        pending = load().finally(() => { pending = undefined; });
      }
      return pending;
    },
    async tz() {
      return (await api.clock()).tz;
    },
    tzSync() {
      const t = now().getTime();
      if (cached && t - cached.at < ttl) return cached.value.tz;
      // Warm it for the NEXT caller and answer now with whatever is to hand. `clock()` never
      // rejects — `load()` catches everything — but the `.catch` is kept so a future change cannot
      // turn this into an unhandled rejection on a path nobody awaits.
      void api.clock().catch(() => {});
      return cached?.value.tz ?? opts.homeTz();
    },
  };
  return api;
}

/** The live instance: Marcel's mounted trip store, this service's pool, the canonical owner. */
const live = makeCachedOwnerClock({
  resolve: (now) =>
    resolveOwnerClock({
      now,
      // Read per call — see this file's header, point 2.
      ...(process.env["TRAVEL_PATH"]?.trim() ? { tripsDir: process.env["TRAVEL_PATH"]!.trim() } : {}),
      db: getPool(),
      owner: ownerId(),
      homeTz: homeTimezone(),
    }),
  homeTz: () => homeTimezone(),
});

/** THE call every turn and every schedule makes. Never throws. */
export async function ownerTz(): Promise<string> {
  return live.tz();
}

/** The same answer plus which source won and why — for a log line, the brief, or the console. */
export async function ownerClock(): Promise<OwnerClock> {
  return live.clock();
}

/** The synchronous reader, for eve's inline approval-card rendering only. Everything else awaits
 *  `ownerTz()` — see {@link CachedOwnerClock.tzSync} for why this one cannot. */
export function ownerTzSync(): string {
  return live.tzSync();
}
