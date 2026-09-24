import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LAR-67 — the two brief SCHEDULES, driven through their real `run()`, on days where the owner's
 * date and the home date differ.
 *
 * `tests/brief-owner-day.test.ts` proves the library answers on the clock it is handed. This file
 * proves the ticks hand it the right one, and that the three things which must agree DO agree:
 *
 *   - the SLOT ("is it 08:00 / 20:00?") and its ledger key `<schedule>/<owner date>T<hour>` — what
 *     stops a brief going out twice;
 *   - the DAY the brief is about (today's / tomorrow's meetings);
 *   - the NIGHT-BEFORE STAMP the evening pass writes and the next morning pass reads.
 *
 * The pattern is `tests/proactivity-wiring.test.ts`'s (fresh import per "process", fake timers, a
 * pool that answers nothing), with two differences: the owner clock is a variable a case can MOVE
 * mid-day, and the gate is a tiny stateful stand-in for the ledger's one rule that matters here —
 * a `sent` row for an item key, ever, means already-seen (ADR 0014 rule 3) — so a "restart" inside
 * a case (`vi.resetModules()`) loses the in-memory `lastSlot` exactly as a real restart does and
 * the ledger still holds.
 */

// ─── the owner clock, movable ───────────────────────────────────────────────────────────────

let ownerTzNow = "Europe/Oslo";
vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz: async () => ownerTzNow,
}));

// ─── the ledger's already-seen rule ─────────────────────────────────────────────────────────

const sentKeys: string[] = [];
const gatedSendMock = vi.fn(async (_db: unknown, req: { itemKey: string }, send: () => Promise<void>) => {
  if (sentKeys.includes(req.itemKey)) return { verdict: "suppress", reason: "already-seen" } as never;
  await send();
  sentKeys.push(req.itemKey);
  return { verdict: "send" } as never;
});
vi.mock("@lares/agent-kit/proactivity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatedSend: gatedSendMock,
  deferredSince: async () => [],
}));

vi.mock("@lares/agent-kit/schedule-heartbeat", () => ({
  recordSchedulePass: async () => true,
  recordScheduleTick: async () => true,
  scheduleKey: (agent: string, schedule: string) => `${agent}/${schedule}`,
  tickKey: (key: string) => `${key}#tick`,
}));
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: async () => {} }));

/**
 * LAR-17-s2 — the hour is a setting now, so this fake pool has to answer two new query shapes:
 * `schedule_settings` (the kit's `readScheduleHours`, via `lib/schedule-hours.ts`) and the
 * `alreadySentToday` guard's own `initiations` lookup. Both default to exactly the OLD behaviour
 * (no row / nothing sent), which is what every PIN above this point relies on: a test only sees a
 * different answer when it deliberately sets `scheduleHoursRow`, and the "sent" answer is derived
 * from THIS FILE's own `sentKeys` — the same fake ledger `gatedSendMock` already maintains, so the
 * two never disagree about what has gone out.
 */
let scheduleHoursRow: Record<string, number[]> = {};
const fakePool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM schedule_settings")) {
      const hours = scheduleHoursRow[params[1] as string];
      return hours ? { rows: [{ hours }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM initiations") && sql.includes("item_key LIKE")) {
      // Mirrors the real WHERE clause: item_key LIKE '<schedule>/%' AND owner_day = $3 — the
      // item key's own date portion has to match, not merely its schedule prefix, or a brief
      // sent on one owner-day would look "already sent" on every later one too.
      const ownerDay = String(params[2] ?? "");
      const prefix = String(params[3] ?? "").replace(/%$/, "");
      const has = sentKeys.some((k) => k.startsWith(prefix) && k.slice(prefix.length).startsWith(`${ownerDay}T`));
      return has ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => fakePool, closePool: async () => {} }));

vi.mock("../lib/identity-client.js", () => ({
  configuredOwnerId: () => "owner",
  listAliases: async () => ["owner@example.com"],
}));

vi.mock("../lib/google.js", () => ({
  googleClients: () => ({
    gmail: async () => ({ searchThreadIds: async () => [], readThread: async () => [] }),
    calendar: async () => ({}),
  }),
  listEnrolledMailboxes: async () => ["owner@example.com"],
}));

// ─── the calendar: one meeting a day, each at 10:00 on the clock named in its title ─────────

interface Ev { id: string; summary: string; start: string; end: string; attendees: Array<{ email: string }> }
let calendarEvents: Ev[] = [];
const meeting = (summary: string, start: string, end: string): Ev => ({
  id: summary, summary, start, end, attendees: [{ email: "them@example.com" }],
});
vi.mock("../lib/calendar-fanout.js", () => ({
  listEventsEverywhere: async (_deps: unknown, o: { timeMin: string; timeMax: string }) =>
    calendarEvents.filter((e) => e.end > o.timeMin && e.start < o.timeMax),
}));

// ─── obligations: one thread, owed to the person in every meeting ───────────────────────────

const OWED = {
  threadId: "t1",
  subject: "The proposal",
  counterpartyName: "Them",
  counterpartyAddress: "them@example.com",
  lastMessageAt: new Date("2026-09-10T09:00:00Z"),
  ageHours: 30,
  isRePing: false,
  unansweredCount: 1,
  source: "gmail" as const,
};
vi.mock("../lib/obligation-pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/obligation-pipeline.js")>()),
  gatherOpenObligations: async () => [OWED],
}));

/** What the evening pass stamped, as the store would hold it: thread → covered day. */
const stamped = new Map<string, string>();
const daysRead: string[] = [];
vi.mock("../lib/obligations-store.js", () => ({
  ensureObligationsTableOnce: async () => {},
  dismissedThreads: async () => new Set<string>(),
  upsertSeen: async () => {},
  markNightBeforeDelivered: async (_db: unknown, threadId: string, opts: { day: string }) => {
    stamped.set(threadId, opts.day);
  },
  nightBeforeDelivered: async (_db: unknown, day: string) => {
    daysRead.push(day);
    return new Set([...stamped].filter(([, d]) => d === day).map(([id]) => id));
  },
  resolvedThreads: async () => new Map<string, Date>(),
  markResolved: async () => {},
  cachedIntent: async () => null,
  recordIntent: async () => {},
  announcedRePings: async () => new Map<string, number>(),
  markRePingAnnounced: async () => {},
}));

// ─── plumbing ───────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID", "TRAVEL_PATH", "BRIEF_PICKS_DIR"];
let saved: Record<string, string | undefined>;
let prompts: string[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["EVE_SCHEDULES_LIVE"] = "1";
  process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";
  ownerTzNow = "Europe/Oslo";
  scheduleHoursRow = {};
  sentKeys.length = 0;
  stamped.clear();
  daysRead.length = 0;
  prompts = [];
  calendarEvents = [];
  gatedSendMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ctx = {
  to: () => ({ send: async (prompt: string) => { prompts.push(prompt); return {}; } }),
  waitUntil: () => {},
  appAuth: {},
} as never;

type Schedule = { run?: (c: never) => Promise<void> };
const morning = async (): Promise<Schedule> => (await import("../agent/schedules/morning-brief.js")).default as Schedule;
const evening = async (): Promise<Schedule> => (await import("../agent/schedules/evening-brief.js")).default as Schedule;

/** One cron tick of `schedule` at `instant`. */
async function tick(schedule: Schedule, instant: string): Promise<void> {
  vi.setSystemTime(new Date(instant));
  await schedule.run!(ctx);
}

const briefKeys = (kind: string) => sentKeys.filter((k) => k.startsWith(`${kind}/`));

/** Which of the calendar's meetings prompt number `n` names — by title, so a failure prints two
 *  short lists rather than a whole prompt. */
const namedIn = (n: number): string[] =>
  calendarEvents.map((e) => e.summary).filter((title) => (prompts[n] ?? "").includes(title));

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PINS — must pass before AND after the change
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("PIN — an ordinary day at home (LAR-67)", () => {
  it("evening then morning: tomorrow's meeting, stamped for the 16th, read back as the 16th", async () => {
    calendarEvents = [
      meeting("wed 10:00 oslo", "2026-09-16T08:00:00Z", "2026-09-16T09:00:00Z"),
      meeting("thu 10:00 oslo", "2026-09-17T08:00:00Z", "2026-09-17T09:00:00Z"),
    ];

    await tick(await evening(), "2026-09-15T18:00:00Z"); // 20:00 Oslo, Tuesday
    expect(sentKeys).toEqual(["evening-brief/2026-09-15T20"]);
    expect(namedIn(0)).toEqual(["wed 10:00 oslo"]);
    expect(stamped.get("t1")).toBe("2026-09-16");

    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Oslo, Wednesday
    expect(sentKeys).toEqual(["evening-brief/2026-09-15T20", "morning-brief/2026-09-16T8"]);
    expect(daysRead).toEqual(["2026-09-16"]);
    expect(namedIn(1)).toEqual(["wed 10:00 oslo"]);
  });
});

describe("PIN — the slot and its ledger key already follow the owner, one brief per owner-day (LAR-67)", () => {
  it("abroad, the home clock's 08:00 and 20:00 fire nothing", async () => {
    ownerTzNow = "America/New_York";
    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Oslo = 02:00 New York
    await tick(await evening(), "2026-09-16T18:00:00Z"); // 20:00 Oslo = 14:00 New York
    expect(sentKeys).toEqual([]);
  });

  it("the same slot minute twice, and once more after a restart, is still ONE brief", async () => {
    ownerTzNow = "America/New_York";
    // A meeting on each day, so the pass has something to say whichever day it takes as tomorrow —
    // this case is about HOW MANY briefs go out, not which day they cover.
    calendarEvents = [
      meeting("wed 10:00 new york", "2026-09-16T14:00:00Z", "2026-09-16T15:00:00Z"),
      meeting("thu 10:00 new york", "2026-09-17T14:00:00Z", "2026-09-17T15:00:00Z"),
    ];

    const first = await evening();
    await tick(first, "2026-09-16T00:00:00Z"); // 20:00 New York, Tuesday
    await tick(first, "2026-09-16T00:00:30Z");
    vi.resetModules(); // a restart: the in-memory `lastSlot` is gone, the ledger is not
    await tick(await evening(), "2026-09-16T00:00:45Z");

    expect(prompts).toHaveLength(1);
    expect(sentKeys).toEqual(["evening-brief/2026-09-15T20"]);
  });

  it("the clock moves WEST after the morning brief: his second 08:00 that date is not a second brief", async () => {
    calendarEvents = [meeting("wed 16:00 oslo", "2026-09-16T14:00:00Z", "2026-09-16T15:00:00Z")];

    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Oslo, Wednesday
    ownerTzNow = "America/New_York";
    vi.resetModules(); // the harder case: only the ledger remembers
    await tick(await morning(), "2026-09-16T12:00:00Z"); // 08:00 New York, the SAME Wednesday

    expect(briefKeys("morning-brief")).toEqual(["morning-brief/2026-09-16T8"]);
    expect(prompts).toHaveLength(1);
  });

  it("the clock moves EAST past his 20:00: that evening's slot is never caught up — a skip, never a double", async () => {
    // Documented conservative behaviour — the choice ADR 0014 rule 4 makes for a slot lost to
    // quiet hours, applied to a slot lost to a moving clock: never caught up.
    // 15:00 in Oslo is already 22:00 in Tokyo, so this Wednesday has no 20:00 left on his clock.
    calendarEvents = [meeting("fri 10:00 tokyo", "2026-09-18T01:00:00Z", "2026-09-18T02:00:00Z")];
    const schedule = await evening();

    ownerTzNow = "Asia/Tokyo";
    await tick(schedule, "2026-09-16T13:00:00Z"); // 15:00 Oslo = 22:00 Tokyo
    await tick(schedule, "2026-09-16T18:00:00Z"); // 20:00 Oslo = 03:00 Tokyo — NOT his evening
    expect(briefKeys("evening-brief")).toEqual([]);

    await tick(schedule, "2026-09-17T11:00:00Z"); // 20:00 Tokyo, Thursday — the next one, once
    expect(briefKeys("evening-brief")).toEqual(["evening-brief/2026-09-17T20"]);
  });

  it("New York morning, Oslo evening: one of each, stamped for the home Thursday the next morning reads", async () => {
    calendarEvents = [
      meeting("wed 10:00 new york", "2026-09-16T14:00:00Z", "2026-09-16T15:00:00Z"),
      meeting("thu 10:00 oslo", "2026-09-17T08:00:00Z", "2026-09-17T09:00:00Z"),
    ];
    ownerTzNow = "America/New_York";
    await tick(await morning(), "2026-09-16T12:00:00Z"); // 08:00 New York, Wednesday
    ownerTzNow = "Europe/Oslo";
    await tick(await evening(), "2026-09-16T18:00:00Z"); // 20:00 Oslo, the same Wednesday
    await tick(await morning(), "2026-09-17T06:00:00Z"); // 08:00 Oslo, Thursday

    expect(sentKeys).toEqual([
      "morning-brief/2026-09-16T8", "evening-brief/2026-09-16T20", "morning-brief/2026-09-17T8",
    ]);
    expect(stamped.get("t1")).toBe("2026-09-17");
    expect(daysRead).toEqual(["2026-09-16", "2026-09-17"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE BUG — the owner's date and the home date differ
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("BUG — New York: the evening brief is about HIS tomorrow, and the stamp follows it (LAR-67)", () => {
  it("20:00 New York on the 15th (02:00 on the 16th at home): one brief, about the 16th, stamped the 16th, read the 16th", async () => {
    ownerTzNow = "America/New_York";
    calendarEvents = [
      meeting("wed 10:00 new york", "2026-09-16T14:00:00Z", "2026-09-16T15:00:00Z"),
      meeting("thu 10:00 new york", "2026-09-17T14:00:00Z", "2026-09-17T15:00:00Z"),
    ];

    await tick(await evening(), "2026-09-16T00:00:00Z"); // 20:00 New York, Tuesday the 15th
    expect(briefKeys("evening-brief")).toEqual(["evening-brief/2026-09-15T20"]);
    expect(namedIn(0)).toEqual(["wed 10:00 new york"]);
    expect(stamped.get("t1")).toBe("2026-09-16");

    await tick(await morning(), "2026-09-16T12:00:00Z"); // 08:00 New York, Wednesday the 16th
    expect(briefKeys("morning-brief")).toEqual(["morning-brief/2026-09-16T8"]);
    // The morning pass asks for exactly the day last night's pass stamped — the two never drift.
    expect(daysRead).toEqual([stamped.get("t1")]);
    expect(prompts).toHaveLength(2); // ONE evening brief and ONE morning brief for his day
  });
});

describe("BUG — Auckland: the morning brief is about HIS today while it is still yesterday at home (LAR-67)", () => {
  it("08:00 Auckland on the 16th (22:00 on the 15th at home): today is the 16th, and so is the day it reads", async () => {
    ownerTzNow = "Pacific/Auckland";
    calendarEvents = [
      meeting("tue 22:00 auckland", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z"),
      meeting("wed 14:00 auckland", "2026-09-16T02:00:00Z", "2026-09-16T03:00:00Z"),
    ];

    await tick(await evening(), "2026-09-15T08:00:00Z"); // 20:00 Auckland, Tuesday the 15th
    expect(stamped.get("t1")).toBe("2026-09-16");

    await tick(await morning(), "2026-09-15T20:00:00Z"); // 08:00 Auckland, Wednesday the 16th
    expect(briefKeys("morning-brief")).toEqual(["morning-brief/2026-09-16T8"]);
    expect(daysRead).toEqual(["2026-09-16"]);
    expect(namedIn(1)).toEqual(["wed 14:00 auckland"]);
  });
});

describe("BUG — the clock changes between the morning and the evening brief (LAR-67)", () => {
  it("Oslo morning, New York evening: one of each, and the evening is about his New York tomorrow", async () => {
    calendarEvents = [
      meeting("wed 16:00 oslo", "2026-09-16T14:00:00Z", "2026-09-16T15:00:00Z"),
      meeting("thu 10:00 new york", "2026-09-17T14:00:00Z", "2026-09-17T15:00:00Z"),
      meeting("fri 10:00 new york", "2026-09-18T14:00:00Z", "2026-09-18T15:00:00Z"),
    ];
    const am = await morning();
    const pm = await evening();

    await tick(am, "2026-09-16T06:00:00Z"); // 08:00 Oslo, Wednesday
    ownerTzNow = "America/New_York";
    await tick(am, "2026-09-16T12:00:00Z"); // 08:00 New York, the same Wednesday — no second brief
    await tick(pm, "2026-09-16T18:00:00Z"); // 20:00 Oslo = 14:00 New York — not his evening
    await tick(pm, "2026-09-17T00:00:00Z"); // 20:00 New York, Wednesday (02:00 Thursday at home)

    expect(sentKeys).toEqual(["morning-brief/2026-09-16T8", "evening-brief/2026-09-16T20"]);
    expect(prompts).toHaveLength(2);
    expect(namedIn(1)).toEqual(["thu 10:00 new york"]);
    expect(stamped.get("t1")).toBe("2026-09-17");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LAR-17-s2 — the hour is a setting now: a stored hour moves the slot, and a mid-day change
// cannot double-send (the edge the ledger's item-key dedupe alone does not catch — see
// lib/initiation.ts's alreadySentToday for why).
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("LAR-17-s2 — a stored hour moves the slot; a mid-day change never double-sends", () => {
  it("no row: today's default hours (08:00 / 20:00) are unchanged", async () => {
    calendarEvents = [meeting("wed 10:00 oslo", "2026-09-16T08:00:00Z", "2026-09-16T09:00:00Z")];
    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Oslo — no schedule_settings row
    expect(sentKeys).toEqual(["morning-brief/2026-09-16T8"]);
  });

  it("a stored hour moves the slot — the old hour no longer fires that day", async () => {
    scheduleHoursRow["morning-brief"] = [7];
    calendarEvents = [meeting("wed 10:00 oslo", "2026-09-16T08:00:00Z", "2026-09-16T09:00:00Z")];

    await tick(await morning(), "2026-09-16T05:00:00Z"); // 07:00 Oslo — the NEW hour
    expect(sentKeys).toEqual(["morning-brief/2026-09-16T7"]);

    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Oslo, the OLD hour, same day
    expect(sentKeys).toEqual(["morning-brief/2026-09-16T7"]); // still just the one brief
  });

  it("the hour moves from 8 to 9 AFTER today's brief already sent — no second brief, even across a restart", async () => {
    calendarEvents = [meeting("wed 10:00 oslo", "2026-09-16T08:00:00Z", "2026-09-16T09:00:00Z")];

    await tick(await morning(), "2026-09-16T06:00:00Z"); // 08:00 Oslo — the default hour
    expect(sentKeys).toEqual(["morning-brief/2026-09-16T8"]);

    // The owner changes the setting in the console, and the process restarts in between — the
    // harder case, matching this file's own convention for a restart: `lastSlot` AND the
    // schedule-hours cache are both gone, so only the DB-backed guard can still catch this.
    scheduleHoursRow["morning-brief"] = [9];
    vi.resetModules();
    await tick(await morning(), "2026-09-16T07:00:00Z"); // 09:00 Oslo, the SAME Wednesday

    // "morning-brief/2026-09-16T9" is a BRAND NEW item key the ledger has never seen — the gate
    // alone would happily send it. `alreadySentToday` is what stops it: one brief that day.
    expect(sentKeys).toEqual(["morning-brief/2026-09-16T8"]);
    expect(prompts).toHaveLength(1);
  });

  it("the same edge for the evening brief, without a restart", async () => {
    calendarEvents = [
      meeting("wed 10:00 oslo", "2026-09-16T08:00:00Z", "2026-09-16T09:00:00Z"),
      meeting("thu 10:00 oslo", "2026-09-17T08:00:00Z", "2026-09-17T09:00:00Z"),
    ];
    const pm = await evening();

    await tick(pm, "2026-09-15T18:00:00Z"); // 20:00 Oslo, Tuesday — the default hour
    expect(sentKeys).toEqual(["evening-brief/2026-09-15T20"]);

    // No restart this time — the schedule-hours cache would still be warm (TTL 5 min) if this
    // were seconds later, so the clock is moved a full hour to prove the fix holds once the
    // cache itself has refreshed too, not only across a restart.
    scheduleHoursRow["evening-brief"] = [21];
    await tick(pm, "2026-09-15T19:00:00Z"); // 21:00 Oslo, the SAME Tuesday

    expect(sentKeys).toEqual(["evening-brief/2026-09-15T20"]);
    expect(prompts).toHaveLength(1);
  });
});
