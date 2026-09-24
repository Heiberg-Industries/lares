// Ported from services/marcel/tests/schedule.test.ts and services/marcel/tests/
// flightwatch.test.ts (Task 7), adapted to eve-marcel's string-id convention and to the new
// split: lib/trip-schedule.ts's pure date-math + ledger (tested here directly, independent of
// the eve schedule wrapper — Ruling 2), lib/flightwatch.ts's pure diff/render logic (including
// the new international-leg card addition, Tier 1 #3), and a thin smoke-test of the eve
// wrapper itself (agent/schedules/trip-lifecycle.ts).
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TripStore, type Trip } from "../lib/trip-store.js";
import {
  TripScheduler,
  tickTrip,
  reminderFireTime,
  isQuietForPost,
  arrivalDateISO,
  postingTimezone,
  bookingTimezone,
  checkoutSchedule,
  type PostKind,
  type TripScheduleDeps,
} from "../lib/trip-schedule.js";
import {
  diffFlightState,
  renderFlightStatus,
  isInternationalLeg,
  DEFAULT_CONNECTION_BUFFER_MIN,
  type WatchState,
} from "../lib/flightwatch.js";
import type { FlightRef, FlightStatus } from "../lib/flights.js";

// ─── shared fixtures ────────────────────────────────────────────────────────────────────

let root: string;
let store: TripStore;

// All trips use timezone "UTC" so test timestamps map 1:1 onto the trip's local clock — no
// real tz conversion needed to reason about the fixtures.
function ts(dateISO: string, time: string): number {
  const [y, mo, d] = dateISO.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);
}

function makeTrip(overrides: Partial<Omit<Trip, "dir" | "chatId">> = {}): Trip {
  const base = {
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-25",
    timezone: "UTC",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
    ...overrides,
  };
  const trip = store.createTrip(base);
  store.linkChat(trip.slug, "555");
  return { ...trip, chatId: "555" };
}

function bookingBlock(id: string, kind: string, startISO: string, time: string): string {
  return `<!-- booking id:${id} kind:${kind} start:${startISO} end:${startISO} time:${time} -->\n- test booking\n<!-- /booking -->\n`;
}

function flightBookingBlock(id: string, startISO: string, time: string, flightNo: string): string {
  return `<!-- booking id:${id} kind:flight start:${startISO} end:${startISO} time:${time} -->\n- ${flightNo} avgang\n<!-- /booking -->\n`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-trip-schedule-"));
  store = new TripStore(root);
  // homeTimezone pinned to UTC alongside every fixture trip's own "UTC" (ORB-124): these
  // fixtures reason about the trip's local clock 1:1 with the test timestamps, and the
  // real default (Europe/Oslo) would silently shift every pre-arrival assertion by two
  // hours. The home-vs-trip switch itself is tested against REAL timezones further down.
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, homeTimezone: "UTC", trips: [] });
});

interface Recorder {
  postCalls: { kind: PostKind; trip: Trip; chatId: string; ctx: Record<string, string> }[];
  errors: { key: string; err: unknown }[];
}

function newRecorder(): Recorder {
  return { postCalls: [], errors: [] };
}

function makeDeps(now: () => number, recorder: Recorder, extra: Partial<TripScheduleDeps> = {}): TripScheduleDeps {
  return {
    store,
    now,
    post: async (kind, trip, chatId, ctx) => {
      recorder.postCalls.push({ kind, trip, chatId, ctx });
    },
    onJobError: (_trip, key, err) => {
      recorder.errors.push({ key, err });
    },
    postFlightMessage: async () => {},
    ...extra,
  };
}

// ─── lib/trip-schedule.ts — lifecycle PostKinds ────────────────────────────────────────────

describe("TripScheduler.tick — evening", () => {
  it("fires exactly once at 20:00, even across a double tick in the same minute, and records sent.json", async () => {
    const trip = makeTrip();
    // Prime the day's earlier catch-up jobs (weatherwarn) with an 08:30 tick so this test
    // isolates the evening post.
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    const now = ts("2026-07-22", "20:00");
    const recorder = newRecorder();
    const scheduler = new TripScheduler(makeDeps(() => now, recorder));

    await scheduler.tick();
    await scheduler.tick(); // double tick, same minute

    const evenings = recorder.postCalls.filter((c) => c.kind === "evening");
    expect(evenings).toHaveLength(1);

    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8"));
    expect(sent["2026-07-22:evening"]).toBe(true);
  });

  it("does not fire outside 20:00", async () => {
    makeTrip();
    const now = ts("2026-07-22", "19:59");
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => now, recorder)).tick();

    expect(recorder.postCalls.filter((c) => c.kind === "evening")).toHaveLength(0);
  });

  it("does not fire the evening post once quiet hours (22:00) have started, even though due < now", async () => {
    makeTrip();
    const now = ts("2026-07-22", "22:30");
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => now, recorder)).tick();

    expect(recorder.postCalls.filter((c) => c.kind === "evening")).toHaveLength(0);
  });

  it("carries the countdown on the pre-trip posts and a sitat on the evening post (ORB-125 moved the countdown off evening)", async () => {
    const trip = makeTrip({ start: "2026-07-25", end: "2026-07-28" });
    store.write(trip, "sitat-2026-07-25.txt", "«god morgen!» — Kari\n");

    // No bookings carry coordinates, so arrival falls back to trip.start (25.7): packing 22.7.
    const recorderPre = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "20:00"), recorderPre)).tick();
    const packing = recorderPre.postCalls.find((c) => c.kind === "packing");
    expect(packing?.ctx.countdownDays).toBe("3");
    expect(packing?.ctx.arrival).toBe("2026-07-25");

    const recorderDuring = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-26", "20:00"), recorderDuring)).tick();
    const evening = recorderDuring.postCalls.find((c) => c.kind === "evening");
    expect(evening?.ctx.sitat).toBe("«god morgen!» — Kari");
    expect(evening?.ctx.countdownDays).toBeUndefined();
  });

  it("fires the 20:00 evening post at 20:03 if the exact minute was missed, but does not double-fire later", async () => {
    makeTrip();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "20:03");
    const recorder = newRecorder();
    const scheduler = new TripScheduler(makeDeps(() => now, recorder));
    await scheduler.tick();
    expect(recorder.postCalls.filter((c) => c.kind === "evening")).toHaveLength(1);

    now = ts("2026-07-22", "20:04");
    await scheduler.tick();
    expect(recorder.postCalls.filter((c) => c.kind === "evening")).toHaveLength(1);
  });
});

describe("TripScheduler.tick — finale replaces evening", () => {
  it("posts finale (not evening) at 20:00 on the trip's end date", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    await new TripScheduler(makeDeps(() => ts("2026-07-25", "08:30"), newRecorder())).tick();

    const now = ts("2026-07-25", "20:00");
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => now, recorder)).tick();

    const kinds = recorder.postCalls.map((c) => c.kind);
    expect(kinds).toContain("finale");
    expect(kinds).not.toContain("evening");
  });

  it("does not fire finale (or evening) at 20:00 on end+1", async () => {
    makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-26", "20:00"), recorder)).tick();

    expect(recorder.postCalls).toHaveLength(0);
  });
});

describe("TripScheduler.tick — weatherwarn", () => {
  it("fires once at 08:30, but never past trip.end", async () => {
    makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), recorder)).tick();
    expect(recorder.postCalls.filter((c) => c.kind === "weatherwarn")).toHaveLength(1);

    const recorderEndPlusOne = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-26", "08:30"), recorderEndPlusOne)).tick();
    expect(recorderEndPlusOne.postCalls.filter((c) => c.kind === "weatherwarn")).toHaveLength(0);
  });
});

describe("TripScheduler.tick — checkout", () => {
  it("fires at 09:00 on end date only when trip.md records a check-out time (contains 'utsjekk')", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "trip.md", "## Hus (fra e-post)\n- Utsjekk: 11:00\n");
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-25", "09:00"), recorder)).tick();

    expect(recorder.postCalls.map((c) => c.kind)).toContain("checkout");
  });

  it("does not fire checkout when trip.md has no Utsjekk", async () => {
    makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-25", "09:00"), recorder)).tick();

    expect(recorder.postCalls.map((c) => c.kind)).not.toContain("checkout");
  });

  // ORB-204 — The Big Apple, 2026-08-31: the family flew home on trip.end (31.8) but the hotel
  // check-out trip.md recorded was the 30th. The post fired on the 31st, a day after they had
  // left, at 09:00 New York = 15:00 Oslo, mid-air. The recorded date wins; trip.end is only the
  // fallback for a trip.md that names no date.
  it("keys the checkout post to the recorded Utsjekk DATE, never to trip.end (the Big Apple shape)", async () => {
    const trip = makeTrip({ start: "2026-08-25", end: "2026-08-31" });
    store.write(trip, "trip.md", "## Hus (fra e-post)\n- Innsjekk: 2026-08-26\n- Utsjekk: 2026-08-30\n");

    const onCheckoutDay = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-08-30", "09:00"), onCheckoutDay)).tick();
    expect(onCheckoutDay.postCalls.filter((c) => c.kind === "checkout")).toHaveLength(1);
    expect(onCheckoutDay.postCalls.find((c) => c.kind === "checkout")?.ctx).toMatchObject({ checkoutDate: "2026-08-30" });

    const onTripEnd = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-08-31", "09:00"), onTripEnd)).tick();
    expect(onTripEnd.postCalls.map((c) => c.kind)).not.toContain("checkout");

    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8")) as Record<string, boolean>;
    expect(sent["2026-08-30:checkout"]).toBe(true);
    expect(sent["2026-08-31:checkout"]).toBeUndefined();
  });

  it("passes a recorded check-out time to the post and does not fire once that time has passed", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "trip.md", "## Hus (fra e-post)\n- Utsjekk: 2026-07-25 11:00\n");

    const late = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-25", "11:30"), late)).tick();
    expect(late.postCalls.map((c) => c.kind)).not.toContain("checkout");

    const morning = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-25", "09:00"), morning)).tick();
    expect(morning.postCalls.find((c) => c.kind === "checkout")?.ctx).toMatchObject({ checkoutDate: "2026-07-25", checkoutTime: "11:00" });
  });
});

describe("checkoutSchedule (ORB-204)", () => {
  it("reads every ISO date on an Utsjekk line, one check-out day per hotel", () => {
    const md = "## Hus (fra e-post)\n- Utsjekk: 2026-08-30\n\n## Hus (fra e-post)\n- Utsjekk: 2026-09-02 kl. 10:00\n";
    expect(checkoutSchedule(md, "2026-09-05")).toEqual([
      { dateISO: "2026-08-30" },
      { dateISO: "2026-09-02", hhmm: "10:00" },
    ]);
  });

  it("accepts a Norwegian dd.mm.yyyy date without mistaking it for a time", () => {
    expect(checkoutSchedule("- Utsjekk: 30.08.2026\n", "2026-08-31")).toEqual([{ dateISO: "2026-08-30" }]);
  });

  it("falls back to trip.end when the line records only a time, and to nothing when there is no line", () => {
    expect(checkoutSchedule("- Utsjekk: 11:00\n", "2026-07-25")).toEqual([{ dateISO: "2026-07-25", hhmm: "11:00" }]);
    expect(checkoutSchedule("## Hus (fra e-post)\n- Wifi: x\n", "2026-07-25")).toEqual([]);
  });
});

describe("reminderFireTime / TripScheduler.tick — reminder", () => {
  it("floors a 06:35 flight's T-3h reminder to the 07:00 quiet-hour floor, not 03:35", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", bookingBlock("msg-1", "flight", "2026-07-23", "06:35"));

    const fire = reminderFireTime({ id: "msg-1", kind: "flight", startISO: "2026-07-23", time: "06:35" });
    expect(fire).toEqual({ dateISO: "2026-07-23", hhmm: "07:00" });

    const at0335 = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-23", "03:35"), at0335)).tick();
    expect(at0335.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(0);

    const at0700 = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-23", "07:00"), at0700)).tick();
    const reminders = at0700.postCalls.filter((c) => c.kind === "reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.ctx.bookingId).toBe("msg-1");

    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8"));
    expect(sent["2026-07-23:reminder:msg-1"]).toBe(true);
  });

  it("defers an evening-quiet reminder forward to next-day 07:00, never backward to same-day 07:00", async () => {
    // 01:30 flight on the 24th: T-3h = 22:30 on the 23rd (quiet hours) → defers FORWARD to
    // 07:00 on the 24th.
    makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const trip = store.trips()[0]!;
    store.write(trip, "bookings.md", bookingBlock("msg-3", "flight", "2026-07-24", "01:30"));

    const at2230 = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-23", "22:30"), at2230)).tick();
    expect(at2230.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(0);

    const nextMorning = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-24", "07:00"), nextMorning)).tick();
    expect(nextMorning.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(1);
  });

  it("a missed daytime reminder does NOT catch up once quiet hours have started", async () => {
    const trip = makeTrip();
    store.write(trip, "bookings.md", bookingBlock("msg-q", "restaurant", "2026-07-22", "16:00"));
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "22:30"), recorder)).tick();

    expect(recorder.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(0);
  });

  it("fires a non-flight booking's reminder at T-1h when that isn't quiet hours", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", bookingBlock("msg-2", "restaurant", "2026-07-22", "20:00"));

    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "19:00"), recorder)).tick();

    expect(recorder.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(1);
  });

  it("still fires a reminder that deferred past midnight on trip.end — at 07:00 on end+1", async () => {
    // 23:00 booking on trip.end: T-1h = 22:00 (quiet) → defers to 07:00 on end+1, which must
    // still be inside TripScheduler's window (windowEnd = addDaysISO(trip.end, 1)).
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", bookingBlock("msg-4", "restaurant", "2026-07-25", "23:00"));

    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-26", "07:00"), recorder)).tick();

    const reminders = recorder.postCalls.filter((c) => c.kind === "reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.ctx.bookingId).toBe("msg-4");
  });

  it("reminder ctx includes live status line when a flights dep is present", async () => {
    makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const trip = store.trips()[0]!;
    store.write(trip, "bookings.md", flightBookingBlock("msg-f4", "2026-07-22", "14:15", "SK4705"));

    const recorder = newRecorder();
    const flights = {
      status: async (): Promise<FlightStatus> => ({
        flightNo: "SK4705", dateISO: "2026-07-22", scheduled: "14:15", statusText: "I rute",
        gate: "E7", cancelled: false, source: "avinor",
      }),
    };
    // T-3h reminder for a 14:15 flight fires at 11:15.
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "11:15"), recorder, { flights })).tick();

    const reminders = recorder.postCalls.filter((c) => c.kind === "reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.ctx.flightStatus).toContain("SK4705");
  });
});

describe("isQuietForPost", () => {
  it("is quiet at and after 22:00, not before", () => {
    expect(isQuietForPost("21:59")).toBe(false);
    expect(isQuietForPost("22:00")).toBe(true);
    expect(isQuietForPost("23:30")).toBe(true);
  });
});

describe("tickTrip — callable directly, independent of TripScheduler", () => {
  it("fires arrival at 17:00 on the ARRIVAL date when called standalone", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const recorder = newRecorder();
    const deps = makeDeps(() => ts("2026-07-22", "17:00"), recorder);

    await tickTrip(deps, trip, { chatId: trip.chatId!, now: ts("2026-07-22", "17:00"), todayISO: "2026-07-22", clockTz: "UTC", arrivalISO: "2026-07-22", homeTz: "UTC" });

    expect(recorder.postCalls.map((c) => c.kind)).toContain("arrival");
  });

  it("does NOT fire arrival on trip.start when arrival is derived later — the Gardermoen night is not an arrival", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const recorder = newRecorder();
    const deps = makeDeps(() => ts("2026-07-21", "17:00"), recorder);

    await tickTrip(deps, trip, { chatId: trip.chatId!, now: ts("2026-07-21", "17:00"), todayISO: "2026-07-21", clockTz: "UTC", arrivalISO: "2026-07-22", homeTz: "UTC" });

    expect(recorder.postCalls.map((c) => c.kind)).not.toContain("arrival");
  });
});

describe("TripScheduler.tick — kill switch", () => {
  it("does nothing when killSwitch is on: no posts, sent.json untouched", async () => {
    const trip = makeTrip();
    const cfg = store.config();
    cfg.killSwitch = true;
    store.saveConfig(cfg);
    const recorder = newRecorder();

    await new TripScheduler(makeDeps(() => ts("2026-07-22", "20:00"), recorder)).tick();

    expect(recorder.postCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(trip.dir, "sent.json"))).toBe(false);
  });

  it("killSwitch on skips the 20:00 tick entirely; once re-enabled, the same day's evening post still fires late", async () => {
    makeTrip();
    const cfg = store.config();
    cfg.killSwitch = true;
    store.saveConfig(cfg);

    const recorderOff = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "20:00"), recorderOff)).tick();
    expect(recorderOff.postCalls).toHaveLength(0);

    const cfg2 = store.config();
    cfg2.killSwitch = false;
    store.saveConfig(cfg2);

    // killSwitch being on all day means nothing marked sent — re-enabling mid-evening catches
    // up not just evening but any other job due earlier that day too (e.g. weatherwarn); the
    // point of this test is that evening specifically still fires once.
    const recorderOn = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "20:05"), recorderOn)).tick();

    expect(recorderOn.postCalls.filter((c) => c.kind === "evening")).toHaveLength(1);
    expect(recorderOn.postCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("TripScheduler.tick — overlapping ticks (in-flight guard)", () => {
  it("a tick() called while a previous tick is still running returns immediately without starting jobs", async () => {
    makeTrip();
    const now = ts("2026-07-22", "20:00");
    const recorder = newRecorder();

    let releasePost!: () => void;
    let signalPostRunning!: () => void;
    const postRunning = new Promise<void>((r) => { signalPostRunning = r; });
    const postBlocker = new Promise<void>((r) => { releasePost = r; });

    const deps: TripScheduleDeps = {
      ...makeDeps(() => now, recorder),
      post: async (kind, trip, chatId, ctx) => {
        signalPostRunning();
        await postBlocker;
        recorder.postCalls.push({ kind, trip, chatId, ctx });
      },
    };

    const scheduler = new TripScheduler(deps);
    const tickA = scheduler.tick();
    await postRunning; // tick A is now stalled mid-job (evening's post)

    await scheduler.tick(); // tick B — must return immediately, starting nothing
    expect(recorder.postCalls).toHaveLength(0);

    releasePost();
    await tickA;

    expect(recorder.postCalls.filter((c) => c.kind === "evening")).toHaveLength(1);
  });

  it("markAndRun re-reads sent.json from disk, so marks written mid-tick by another instance are respected", async () => {
    // Two TripScheduler instances on the same trip dir (no shared `running` flag): A loads its
    // in-memory sent copy, marks+stalls inside evening's post (the FIRST job tickTrip
    // evaluates); B does a full fast tick, which sees evening already marked on disk (A wrote
    // that mark before stalling) and instead marks+runs weatherwarn; when A resumes and reaches
    // weatherwarn's own markAndRun, its in-memory copy is stale — the fresh check-and-set must
    // see B's weatherwarn mark and skip, proving the ledger is re-read from disk each call
    // rather than trusted from a copy loaded once at the start of the tick. Adapted from old
    // Marcel's own version of this test (services/marcel/tests/schedule.test.ts:397-430), which
    // used "dream" (evaluated before evening there) as the stalled job — this port has no dream
    // job, so it stalls on evening (tickTrip's own first job) instead and observes the effect
    // on weatherwarn (tickTrip's next due job) rather than on evening itself.
    makeTrip();
    const now = ts("2026-07-22", "20:00");

    let releasePost!: () => void;
    let signalPostRunning!: () => void;
    const postRunning = new Promise<void>((r) => { signalPostRunning = r; });
    const postBlocker = new Promise<void>((r) => { releasePost = r; });

    const recorderA = newRecorder();
    const depsA: TripScheduleDeps = {
      ...makeDeps(() => now, recorderA),
      post: async (kind, trip, chatId, ctx) => {
        if (kind === "evening") {
          signalPostRunning();
          await postBlocker;
        }
        recorderA.postCalls.push({ kind, trip, chatId, ctx });
      },
    };
    const recorderB = newRecorder();

    const tickA = new TripScheduler(depsA).tick();
    await postRunning; // A has marked+is stalled inside evening's post

    await new TripScheduler(makeDeps(() => now, recorderB)).tick(); // B's full tick: skips evening (already marked), marks+runs weatherwarn

    releasePost();
    await tickA;

    expect(recorderB.postCalls.filter((c) => c.kind === "weatherwarn")).toHaveLength(1);
    expect(recorderA.postCalls.filter((c) => c.kind === "weatherwarn")).toHaveLength(0);
  });
});

describe("TripScheduler.tick — onJobError", () => {
  it("is invoked (and tick() does not throw) when post fails for a job", async () => {
    makeTrip();
    const now = ts("2026-07-22", "20:00");
    const recorder = newRecorder();
    const deps: TripScheduleDeps = {
      ...makeDeps(() => now, recorder),
      post: async (kind) => {
        if (kind === "evening") throw new Error("post boom");
      },
    };

    await expect(new TripScheduler(deps).tick()).resolves.toBeUndefined();

    expect(recorder.errors).toHaveLength(1);
    expect(recorder.errors[0]!.key).toBe("2026-07-22:evening");
    expect((recorder.errors[0]!.err as Error).message).toBe("post boom");
  });
});

describe("TripScheduler.tick — trip filtering", () => {
  it("ignores a trip with no chatId", async () => {
    store.createTrip({
      slug: "unlinked", name: "Unlinked", start: "2026-07-21", end: "2026-07-25",
      timezone: "UTC", destination: { name: "X", lat: 0, lon: 0 },
    });
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "20:00"), recorder)).tick();

    expect(recorder.postCalls).toHaveLength(0);
  });

  it("ignores a trip whose window (start-7 .. end+1) doesn't include today", async () => {
    makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-05-01", "20:00"), recorder)).tick();

    expect(recorder.postCalls).toHaveLength(0);
  });
});

// ─── lib/trip-schedule.ts — flight watch ───────────────────────────────────────────────────

describe("TripScheduler.tick — flight watch", () => {
  it("polls flights on travel day inside the T-6h window and posts material changes via the legacy per-diff path (no postFlightMessageWithId/editFlightMessage)", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-f1", "2026-07-22", "14:15", "SK4705"));
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "10:00"); // inside T-6h..T+1h window (08:15..15:15)
    const posted: string[] = [];
    let calls = 0;
    const flights = {
      status: async (ref: FlightRef): Promise<FlightStatus> => {
        calls++;
        return {
          flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15",
          gate: calls === 1 ? undefined : "E7", // 1st call = baseline, 2nd = gate assigned
          cancelled: false, source: "avinor",
        };
      },
    };
    const recorder = newRecorder();
    const scheduler = new TripScheduler({
      ...makeDeps(() => now, recorder),
      flights,
      postFlightMessage: async (_chatId, text) => { posted.push(text); },
    });

    await scheduler.tick();
    now = ts("2026-07-22", "10:06"); // ≥5 min later — clears the poll self-gate
    await scheduler.tick();

    expect(calls).toBe(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("E7");
  });

  it("does not poll outside the window (T-7h) or without a flights dep", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-f2", "2026-07-22", "14:15", "SK4705"));

    const now = ts("2026-07-22", "07:00"); // T-7h15 — outside the T-6h window

    const posted: string[] = [];
    await new TripScheduler(makeDeps(() => now, newRecorder(), { postFlightMessage: async (_c, t) => { posted.push(t); } })).tick();
    expect(posted).toHaveLength(0);
    expect(fs.existsSync(path.join(trip.dir, "flight-state.json"))).toBe(false);

    let calls = 0;
    const flights = { status: async (ref: FlightRef): Promise<FlightStatus> => { calls++; return { flightNo: ref.flightNo, dateISO: ref.dateISO, cancelled: false, source: "avinor" }; } };
    await new TripScheduler(makeDeps(() => now, newRecorder(), { flights, postFlightMessage: async (_c, t) => { posted.push(t); } })).tick();
    expect(calls).toBe(0); // outside the per-flight window — status() never reached
    expect(posted).toHaveLength(0);
  });

  it("material-shift threshold: first material change posts once with id; a second change EDITS the same message (edit-in-place)", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-f5", "2026-07-22", "14:15", "SK4705"));
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "10:00");
    let calls = 0;
    const flights = {
      status: async (ref: FlightRef): Promise<FlightStatus> => {
        calls++;
        if (calls === 1) return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", cancelled: false, source: "avinor" }; // baseline
        if (calls === 2) return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", estimated: "14:40", cancelled: false, source: "avinor" }; // +25 min delay (≥10 min threshold)
        return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", estimated: "14:40", gate: "A10", cancelled: false, source: "avinor" }; // gate assigned
      },
    };
    const posts: string[] = [];
    const edits: { messageId: string; text: string }[] = [];
    const scheduler = new TripScheduler({
      ...makeDeps(() => now, newRecorder()),
      flights,
      postFlightMessage: async () => {},
      postFlightMessageWithId: async (_chatId, text) => { posts.push(text); return "88"; },
      editFlightMessage: async (_chatId, messageId, text) => { edits.push({ messageId, text }); return true; },
    });

    await scheduler.tick(); // poll 1: baseline — no post
    now = ts("2026-07-22", "10:06");
    await scheduler.tick(); // poll 2: +25 min delay — first material change
    now = ts("2026-07-22", "10:12");
    await scheduler.tick(); // poll 3: gate A10 — second material change

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("ny tid");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe("88");
    expect(edits[0]!.text).toContain("Gate: A10");
  });

  it("flight watch: a failed edit falls back to a fresh post and adopts the new message id", async () => {
    // Ported from services/marcel/tests/schedule.test.ts:692-739 — a real production failure
    // mode (e.g. Telegram rejecting an edit because the live message was deleted). editFlightMessage
    // always returns false here, forcing every material change down the fallback path.
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-f6", "2026-07-22", "14:15", "SK4705"));
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "10:00");
    let calls = 0;
    const flights = {
      status: async (ref: FlightRef): Promise<FlightStatus> => {
        calls++;
        if (calls === 1) return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", cancelled: false, source: "avinor" }; // baseline
        if (calls === 2) return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", estimated: "14:40", cancelled: false, source: "avinor" }; // +25 min delay
        return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", estimated: "14:40", gate: "A10", cancelled: false, source: "avinor" }; // gate assigned
      },
    };
    const postIds = ["88", "99"];
    let postCalls = 0;
    const posts: { id: string; text: string }[] = [];
    let editCalls = 0;
    const scheduler = new TripScheduler({
      ...makeDeps(() => now, newRecorder()),
      flights,
      postFlightMessage: async () => {},
      postFlightMessageWithId: async (_chatId, text) => {
        const id = postIds[postCalls]!;
        postCalls++;
        posts.push({ id, text });
        return id;
      },
      editFlightMessage: async () => {
        editCalls++;
        return false; // edit always fails — forces the fallback path
      },
    });

    await scheduler.tick(); // poll 1: baseline
    now = ts("2026-07-22", "10:06");
    await scheduler.tick(); // poll 2: delay — posts fresh, id 88
    now = ts("2026-07-22", "10:12");
    await scheduler.tick(); // poll 3: gate — edit(88) fails, falls back to a fresh post, id 99

    expect(editCalls).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.id).toBe("99");
    const state = JSON.parse(fs.readFileSync(path.join(trip.dir, "flight-state.json"), "utf8"));
    expect(state["SK4705:2026-07-22"].messageId).toBe("99");
  });

  it("cancellation posts fresh (never edits) even when a live edit-in-place message exists, and bypasses quiet hours", async () => {
    // A late (23:30) departure so the T-6h..T+1h watch window (17:30..00:30) genuinely
    // overlaps quiet hours (>=22:00) — the case the quiet-hours-bypass assertion needs.
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-f7", "2026-07-22", "23:30", "SK4705"));
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "20:00");
    let calls = 0;
    const flights = {
      status: async (ref: FlightRef): Promise<FlightStatus> => {
        calls++;
        if (calls === 1) return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "23:30", cancelled: false, source: "avinor" }; // baseline
        if (calls === 2) return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "23:30", estimated: "23:55", cancelled: false, source: "avinor" }; // +25 min delay
        return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "23:30", estimated: "23:55", cancelled: true, source: "avinor" }; // cancelled
      },
    };
    const rawPosts: string[] = [];
    const editedPosts: string[] = [];
    let editCalls = 0;
    const scheduler = new TripScheduler({
      ...makeDeps(() => now, newRecorder()),
      flights,
      postFlightMessage: async (_c, text) => { rawPosts.push(text); },
      postFlightMessageWithId: async (_c, text) => { editedPosts.push(text); return "88"; },
      editFlightMessage: async () => { editCalls++; return true; },
    });

    await scheduler.tick(); // poll 1 (20:00): baseline — no post
    now = ts("2026-07-22", "20:06"); // ≥5 min later, clears the poll self-gate
    await scheduler.tick(); // poll 2 (20:06): +25 min delay — posts fresh via postFlightMessageWithId, establishes messageId 88
    expect(editedPosts).toHaveLength(1);

    now = ts("2026-07-22", "22:15"); // ≥5 min later AND inside quiet hours (still within the watch window)
    await scheduler.tick(); // poll 3 (22:15): cancelled — must post fresh (never edit), quiet hours or not

    expect(editCalls).toBe(0); // the live message from poll 2 exists, yet cancellation never edits it
    expect(rawPosts).toHaveLength(1);
    expect(rawPosts[0]).toContain("🔴");
    expect(rawPosts[0]!.toLowerCase()).toContain("kansellert");
    const state = JSON.parse(fs.readFileSync(path.join(trip.dir, "flight-state.json"), "utf8"));
    expect(state["SK4705:2026-07-22"].messageId).toBeUndefined();
  });

  it("persists watch state to flight-state.json so a restart does not re-post", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-f3", "2026-07-22", "14:15", "SK4705"));
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "10:00");
    let calls = 0;
    const flights = {
      status: async (ref: FlightRef): Promise<FlightStatus> => {
        const gate = calls === 0 ? undefined : "E7";
        calls++;
        return { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", gate, cancelled: false, source: "avinor" };
      },
    };
    const posted: string[] = [];
    const schedulerA = new TripScheduler({ ...makeDeps(() => now, newRecorder()), flights, postFlightMessage: async (_c, t) => { posted.push(t); } });
    await schedulerA.tick(); // baseline — no post
    now = ts("2026-07-22", "10:06");
    await schedulerA.tick(); // gate E7 → posts once

    expect(posted).toHaveLength(1);
    expect(fs.existsSync(path.join(trip.dir, "flight-state.json"))).toBe(true);

    // Restart: a brand-new TripScheduler on the same trip dir, fed the same live status (gate
    // still E7) — must load the persisted state and NOT re-post.
    now = ts("2026-07-22", "10:12");
    const schedulerB = new TripScheduler({ ...makeDeps(() => now, newRecorder()), flights, postFlightMessage: async (_c, t) => { posted.push(t); } });
    await schedulerB.tick();

    expect(posted).toHaveLength(1);
  });
});

// ─── lib/flightwatch.ts — diffFlightState / renderFlightStatus ─────────────────────────────

const BASE: FlightStatus = {
  flightNo: "SK4705", dateISO: "2026-07-22", from: "OSL", to: "NCE",
  scheduled: "14:15", cancelled: false, source: "avinor",
};

describe("diffFlightState", () => {
  it("first sighting posts nothing (baseline only)", () => {
    const { messages, next } = diffFlightState({}, BASE, { quiet: false });
    expect(messages).toEqual([]);
    expect(next["SK4705:2026-07-22"]).toBeDefined();
  });

  it("estimated shift ≥10 min posts a delay message once, then not again for the same estimate", () => {
    const state: WatchState = diffFlightState({}, BASE, { quiet: false }).next;
    const delayed = { ...BASE, estimated: "14:55" };
    const r1 = diffFlightState(state, delayed, { quiet: false });
    expect(r1.messages.length).toBe(1);
    expect(r1.messages[0]).toContain("14:55");
    const r2 = diffFlightState(r1.next, delayed, { quiet: false });
    expect(r2.messages).toEqual([]);
  });

  it("estimated shift <10 min is ignored (material-shift threshold)", () => {
    const state = diffFlightState({}, BASE, { quiet: false }).next;
    const wobble = { ...BASE, estimated: "14:22" }; // +7 min
    expect(diffFlightState(state, wobble, { quiet: false }).messages).toEqual([]);
  });

  it("quiet hours suppress everything except cancellation, which always alerts", () => {
    const state = diffFlightState({}, BASE, { quiet: false }).next;
    expect(diffFlightState(state, { ...BASE, estimated: "15:30" }, { quiet: true }).messages).toEqual([]);
    const r = diffFlightState(state, { ...BASE, cancelled: true }, { quiet: true });
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.toLowerCase()).toContain("kansellert");
  });

  it("diffFlightState preserves messageId (string) across updates", () => {
    const st = { flightNo: "SK4705", dateISO: "2026-07-22", scheduled: "14:15", estimated: "14:40", cancelled: false, source: "avinor" } as const;
    const prev: WatchState = { "SK4705:2026-07-22": { estimated: "14:15", messageId: "88" } };
    const { next } = diffFlightState(prev, st, { quiet: false });
    expect(next["SK4705:2026-07-22"]!.messageId).toBe("88");
  });
});

describe("renderFlightStatus", () => {
  it("shows delay, gate, check-in, credit and update time", () => {
    const st = { flightNo: "SK4705", dateISO: "2026-07-22", from: "OSL", to: "NCE", scheduled: "14:15", estimated: "14:40", gate: "A10", checkIn: "4-6", cancelled: false, source: "avinor" } as const;
    const text = renderFlightStatus(st, "12:05");
    expect(text).toContain("SK4705");
    expect(text).toContain("OSL–NCE");
    expect(text).toContain("**14:40**");
    expect(text).toContain("(planlagt 14:15)");
    expect(text).toContain("Gate: A10");
    expect(text).toContain("Innsjekk: 4-6");
    expect(text).toContain("Oppdatert 12:05");
    expect(text).toContain("Flydata fra Avinor");
  });

  it("without changes, shows scheduled time and no Avinor credit for aerodatabox", () => {
    const st = { flightNo: "SK4706", dateISO: "2026-07-29", scheduled: "12:20", cancelled: false, source: "aerodatabox" } as const;
    const text = renderFlightStatus(st, "09:00");
    expect(text).toContain("Avgang: 12:20");
    expect(text).not.toContain("Avinor");
  });
});

// ─── international-leg resilience (Tier 1 #3, approved 2026-08-16) ────────────────────────

describe("isInternationalLeg", () => {
  it("is true when exactly one endpoint is a Norwegian airport", () => {
    expect(isInternationalLeg("OSL", "NCE")).toBe(true); // Norway → France
    expect(isInternationalLeg("NCE", "OSL")).toBe(true); // France → Norway
  });

  it("is false for a domestic Norwegian leg", () => {
    expect(isInternationalLeg("OSL", "BGO")).toBe(false); // Oslo → Bergen
  });

  it("is false when either endpoint is missing (no data to derive a border crossing from)", () => {
    expect(isInternationalLeg(undefined, "NCE")).toBe(false);
    expect(isInternationalLeg("OSL", undefined)).toBe(false);
    expect(isInternationalLeg(undefined, undefined)).toBe(false);
  });
});

describe("renderFlightStatus — international-leg card", () => {
  it("includes the customs/connection-buffer line for an international leg, with the default 90-min threshold", () => {
    const st: FlightStatus = { flightNo: "SK4705", dateISO: "2026-07-22", from: "OSL", to: "NCE", scheduled: "14:15", cancelled: false, source: "avinor" };
    const text = renderFlightStatus(st, "12:05");
    expect(text).toContain("🛂");
    expect(text).toContain(String(DEFAULT_CONNECTION_BUFFER_MIN));
  });

  it("does NOT include the customs line for a domestic leg", () => {
    const st: FlightStatus = { flightNo: "DY123", dateISO: "2026-07-22", from: "OSL", to: "BGO", scheduled: "14:15", cancelled: false, source: "avinor" };
    const text = renderFlightStatus(st, "12:05");
    expect(text).not.toContain("🛂");
  });

  it("honors a configurable connectionBufferMinutes threshold instead of the hardcoded default", () => {
    const st: FlightStatus = { flightNo: "SK4705", dateISO: "2026-07-22", from: "OSL", to: "NCE", scheduled: "14:15", cancelled: false, source: "avinor" };
    const text = renderFlightStatus(st, "12:05", { connectionBufferMinutes: 45 });
    expect(text).toContain("45");
    expect(text).not.toContain(String(DEFAULT_CONNECTION_BUFFER_MIN));
  });
});

describe("TripScheduler.tick — flight watch threads connectionBufferMinutes through to the international-leg card", () => {
  it("an edited-in-place international-leg card carries the configured threshold", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    store.write(trip, "bookings.md", flightBookingBlock("msg-intl", "2026-07-22", "14:15", "SK4705"));
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "08:30"), newRecorder())).tick();

    let now = ts("2026-07-22", "10:00");
    let calls = 0;
    const flights = {
      status: async (ref: FlightRef): Promise<FlightStatus> => {
        calls++;
        return {
          flightNo: ref.flightNo, dateISO: ref.dateISO, from: "OSL", to: "NCE", scheduled: "14:15",
          gate: calls === 1 ? undefined : "E7", cancelled: false, source: "avinor",
        };
      },
    };
    const posts: string[] = [];
    const scheduler = new TripScheduler({
      ...makeDeps(() => now, newRecorder()),
      flights,
      postFlightMessage: async () => {},
      postFlightMessageWithId: async (_c, text) => { posts.push(text); return "1"; },
      editFlightMessage: async () => true,
      connectionBufferMinutes: 60,
    });

    await scheduler.tick();
    now = ts("2026-07-22", "10:06");
    await scheduler.tick();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("🛂");
    expect(posts[0]).toContain("60");
  });
});

// ─── ORB-124 — the derived arrival date ───────────────────────────────────────────────────

describe("arrivalDateISO", () => {
  // The Big Apple's real destination and its real bookings.md headers, coordinates included.
  const bigApple = {
    slug: "the-big-apple",
    name: "The Big Apple",
    start: "2026-08-25",
    end: "2026-08-31",
    timezone: "America/New_York",
    destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    dir: "/nowhere",
  };
  const realBookings = [
    "<!-- booking id:a kind:restaurant start:2026-08-28 end:- time:20:00 at:40.72583,-73.99300 -->\n- Resy\n<!-- /booking -->",
    "<!-- booking id:b kind:restaurant start:2026-08-29 end:- time:20:00 at:40.73960,-73.98836 -->\n- Dining Room\n<!-- /booking -->",
    // The night before departure — Gardermoen, still in Oslo. THE case this rule exists for.
    "<!-- booking id:c kind:stay start:2026-08-25 end:2026-08-26 time:- at:60.18575,11.06517 -->\n- Scandic\n<!-- /booking -->",
    "<!-- booking id:d kind:restaurant start:2026-08-27 end:- time:20:00 at:40.73562,-74.00667 -->\n- Second Floor\n<!-- /booking -->",
    "<!-- booking id:e kind:restaurant start:2026-08-26 end:- time:20:00 at:40.73846,-73.98851 -->\n- Outdoor Tavern Dining\n<!-- /booking -->",
  ].join("\n");

  it("yields 26.8 on the real trip — the Gardermoen night on 25.8 is NOT an arrival", () => {
    expect(arrivalDateISO(bigApple, realBookings)).toBe("2026-08-26");
    expect(arrivalDateISO(bigApple, realBookings)).not.toBe(bigApple.start);
  });

  it("falls back to trip.start when no booking carries coordinates", () => {
    const noCoords =
      "<!-- booking id:x kind:stay start:2026-08-26 end:2026-08-30 time:- -->\n- QUEEN GREAT VIEW\n<!-- /booking -->";
    expect(arrivalDateISO(bigApple, noCoords)).toBe("2026-08-25");
  });

  it("falls back to trip.start when bookings.md is empty", () => {
    expect(arrivalDateISO(bigApple, "")).toBe("2026-08-25");
  });

  it("ignores a booking at the destination dated outside the trip — a filing mistake is not an arrival", () => {
    const early = "<!-- booking id:y kind:restaurant start:2026-07-04 end:- time:20:00 at:40.73846,-73.98851 -->\n- ?\n<!-- /booking -->";
    expect(arrivalDateISO(bigApple, early)).toBe("2026-08-25");
    const late = "<!-- booking id:z kind:restaurant start:2026-09-14 end:- time:20:00 at:40.73846,-73.98851 -->\n- ?\n<!-- /booking -->";
    expect(arrivalDateISO(bigApple, late)).toBe("2026-08-25");
  });

  it("counts a booking within 200 km of the destination and rejects one beyond it", () => {
    // Philadelphia (~130 km) counts; Boston (~300 km) does not.
    const philly = "<!-- booking id:p kind:stay start:2026-08-26 end:- time:- at:39.9526,-75.1652 -->\n- ?\n<!-- /booking -->";
    expect(arrivalDateISO(bigApple, philly)).toBe("2026-08-26");
    const boston = "<!-- booking id:q kind:stay start:2026-08-26 end:- time:- at:42.3601,-71.0589 -->\n- ?\n<!-- /booking -->";
    expect(arrivalDateISO(bigApple, boston)).toBe("2026-08-25");
  });
});

// ─── ORB-124 — home clock before arrival, trip clock from it ───────────────────────────────

describe("postingTimezone", () => {
  const westward = {
    slug: "ny", name: "NY", start: "2026-08-25", end: "2026-08-31",
    timezone: "America/New_York", destination: { name: "New York", lat: 40.7128, lon: -74.006 }, dir: "/nowhere",
  };
  const eastward = {
    slug: "tokyo", name: "Tokyo", start: "2026-08-25", end: "2026-08-31",
    timezone: "Asia/Tokyo", destination: { name: "Tokyo", lat: 35.6762, lon: 139.6503 }, dir: "/nowhere",
  };
  const HOME = "Europe/Oslo";
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it("posts on the home clock the evening before arrival — the 20:00-Oslo departure post", () => {
    // 2026-08-25 20:00 Oslo = 14:00 New York, still 25.8 there. Arrival is 26.8.
    expect(postingTimezone(westward, "2026-08-26", HOME, at("2026-08-25T18:00:00Z"))).toBe(HOME);
  });

  it("is still on the home clock at 02:00 Oslo — the hour the 2026-08-19 post actually landed", () => {
    // 2026-08-19 02:00 Oslo = 2026-08-18 20:00 New York: the old code's evening post.
    expect(postingTimezone(westward, "2026-08-26", HOME, at("2026-08-19T00:00:00Z"))).toBe(HOME);
  });

  it("switches to the trip clock at midnight in New York on arrival day, not at midnight in Oslo", () => {
    // 05:00 Oslo on 26.8 = 23:00 on 25.8 in New York — the trip clock has not arrived yet.
    expect(postingTimezone(westward, "2026-08-26", HOME, at("2026-08-26T03:00:00Z"))).toBe(HOME);
    // 06:00 Oslo = 00:00 New York on 26.8 — from here on, his own clock.
    expect(postingTimezone(westward, "2026-08-26", HOME, at("2026-08-26T04:00:00Z"))).toBe("America/New_York");
    // And that evening's post lands at 20:00 where he is.
    expect(postingTimezone(westward, "2026-08-26", HOME, at("2026-08-27T00:00:00Z"))).toBe("America/New_York");
  });

  it("flying EAST, stays home until the home clock agrees — or the T-1 post would never fire", () => {
    // 2026-08-25 17:00 Oslo = 2026-08-26 00:00 Tokyo. The trip clock has already reached the
    // arrival date, but the departure post is due at 20:00 Oslo THAT SAME EVENING: switching
    // here would move todayISO past its date and drop the post entirely.
    expect(postingTimezone(eastward, "2026-08-26", HOME, at("2026-08-25T15:00:00Z"))).toBe(HOME);
    expect(postingTimezone(eastward, "2026-08-26", HOME, at("2026-08-25T18:00:00Z"))).toBe(HOME);
    // Midnight in Oslo on 26.8 — both clocks agree, and Tokyo takes over.
    expect(postingTimezone(eastward, "2026-08-26", HOME, at("2026-08-25T22:00:00Z"))).toBe("Asia/Tokyo");
  });
});

// ─── ORB-124 — the two working together, end to end through the scheduler ──────────────────

describe("TripScheduler.tick — the resolved clock drives the posts", () => {
  function bigAppleTrip(): Trip {
    const trip = store.createTrip({
      slug: "clock-2026",
      name: "The Big Apple",
      start: "2026-08-25",
      end: "2026-08-31",
      timezone: "America/New_York",
      destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    });
    store.linkChat(trip.slug, "555");
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:c kind:stay start:2026-08-25 end:2026-08-26 time:- at:60.18575,11.06517 -->\n- Scandic Gardermoen\n<!-- /booking -->\n" +
        "<!-- booking id:e kind:restaurant start:2026-08-26 end:- time:19:00 at:40.73846,-73.98851 -->\n- Outdoor Tavern Dining\n<!-- /booking -->\n",
    );
    return { ...trip, chatId: "555" };
  }

  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  beforeEach(() => {
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, homeTimezone: "Europe/Oslo", trips: [] });
  });

  it("fires the pre-trip departure post at 20:00 OSLO, and nothing at 02:00 Oslo as it used to", async () => {
    bigAppleTrip();
    const recorder = newRecorder();

    // 02:00 Oslo on 26.8 = 20:00 New York on 25.8 — the old behaviour's firing moment.
    await new TripScheduler(makeDeps(() => at("2026-08-26T00:00:00Z"), recorder)).tick();
    expect(recorder.postCalls).toHaveLength(0);

    // 20:00 Oslo on 25.8 = arrival - 1: the departure post, where it belongs while he is home.
    await new TripScheduler(makeDeps(() => at("2026-08-25T18:00:00Z"), recorder)).tick();
    const departures = recorder.postCalls.filter((c) => c.kind === "departure");
    expect(departures).toHaveLength(1);
    expect(departures[0]!.ctx.countdownDays).toBe("1");
    expect(departures[0]!.ctx.arrival).toBe("2026-08-26");
  });

  it("keys the ledger by the HOME date before arrival, so the Oslo evening is one day's post", async () => {
    const trip = bigAppleTrip();
    await new TripScheduler(makeDeps(() => at("2026-08-25T18:00:00Z"), newRecorder())).tick();
    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8"));
    expect(sent["2026-08-25:departure"]).toBe(true);
  });

  it("hands the trip clock over on the derived arrival date, not on trip.start", async () => {
    bigAppleTrip();

    // 25.8 is trip.start but NOT arrival (Gardermoen). 02:00 Oslo on 26.8 = 20:00 NY on 25.8:
    // if the clock had switched on trip.start, this would post.
    const onStart = newRecorder();
    await new TripScheduler(makeDeps(() => at("2026-08-26T00:00:00Z"), onStart)).tick();
    expect(onStart.postCalls.filter((c) => c.kind === "evening")).toHaveLength(0);

    // 02:00 Oslo on 27.8 = 20:00 NY on 26.8, the arrival date — his own evening, his own clock.
    const onArrival = newRecorder();
    await new TripScheduler(makeDeps(() => at("2026-08-27T00:00:00Z"), onArrival)).tick();
    expect(onArrival.postCalls.filter((c) => c.kind === "evening")).toHaveLength(1);
  });

  it("defaults the home clock to Europe/Oslo when config.json predates homeTimezone", async () => {
    // An already-provisioned box must not break: no homeTimezone field at all.
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
    bigAppleTrip();
    const recorder = newRecorder();

    await new TripScheduler(makeDeps(() => at("2026-08-26T00:00:00Z"), recorder)).tick();
    expect(recorder.postCalls).toHaveLength(0); // 02:00 Oslo
    await new TripScheduler(makeDeps(() => at("2026-08-25T18:00:00Z"), recorder)).tick();
    expect(recorder.postCalls.filter((c) => c.kind === "departure")).toHaveLength(1); // 20:00 Oslo
  });
});

// ─── ORB-125 — the whole rhythm, day by day, across a real trip window ─────────────────────

describe("the posting rhythm across a whole trip window", () => {
  // The Big Apple exactly as it is on the box: journey starts 25.8 (Gardermoen), derived
  // arrival 26.8, ends 31.8. So packing = 23.8 and departure = 25.8, both on the Oslo clock.
  function bigApple(): Trip {
    const trip = store.createTrip({
      slug: "rhythm-2026",
      name: "The Big Apple",
      start: "2026-08-25",
      end: "2026-08-31",
      timezone: "America/New_York",
      destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    });
    store.linkChat(trip.slug, "555");
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:c kind:stay start:2026-08-25 end:2026-08-26 time:- at:60.18575,11.06517 -->\n- Scandic Gardermoen\n<!-- /booking -->\n" +
        "<!-- booking id:e kind:restaurant start:2026-08-26 end:- time:20:00 at:40.73846,-73.98851 -->\n- Outdoor Tavern Dining\n<!-- /booking -->\n",
    );
    return { ...trip, chatId: "555" };
  }

  beforeEach(() => {
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, homeTimezone: "Europe/Oslo", trips: [] });
  });

  /** Every scheduled post over a range of days, ticking the two decision minutes each day on
   *  BOTH clocks — so a post that fires on either one is caught. One shared recorder and one
   *  shared sent.json across the sweep: at-most-once is part of what is being asserted. */
  async function sweep(fromISO: string, toISO: string): Promise<{ day: string; kind: PostKind }[]> {
    const recorder = newRecorder();
    const seen: { day: string; kind: PostKind }[] = [];
    let cursor = fromISO;
    while (cursor <= toISO) {
      for (const utcHour of [
        "06:30", "12:30", // 08:30 / 14:30 Oslo   → 02:30 / 08:30 New York
        "15:00", "18:00", // 17:00 / 20:00 Oslo   → 11:00 / 14:00 New York
        "21:00", "00:00", // 23:00 Oslo / next 02:00 Oslo → 17:00 / 20:00 New York
      ]) {
        const dayForTick = utcHour === "00:00" ? addDays(cursor, 1) : cursor;
        const at = Math.floor(new Date(`${dayForTick}T${utcHour}:00Z`).getTime() / 1000);
        const before = recorder.postCalls.length;
        await new TripScheduler(makeDeps(() => at, recorder)).tick();
        for (const call of recorder.postCalls.slice(before)) seen.push({ day: cursor, kind: call.kind });
      }
      cursor = addDays(cursor, 1);
    }
    return seen;
  }

  function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  it("says nothing at all from a week out until three days before arrival", async () => {
    bigApple();
    // 18.8 (the old trip.start - 7 window opening) through 22.8, the day before packing.
    expect(await sweep("2026-08-18", "2026-08-22")).toEqual([]);
  });

  it("posts exactly twice before the trip: packing on 23.8 and departure on 25.8", async () => {
    bigApple();
    const posts = await sweep("2026-08-23", "2026-08-25");
    expect(posts).toEqual([
      { day: "2026-08-23", kind: "packing" },
      { day: "2026-08-25", kind: "departure" },
    ]);
  });

  it("neither the evening post nor the 08:30 weather post fires before the arrival date", async () => {
    bigApple();
    const posts = await sweep("2026-08-18", "2026-08-25");
    expect(posts.filter((p) => p.kind === "evening")).toEqual([]);
    expect(posts.filter((p) => p.kind === "weatherwarn")).toEqual([]);
  });

  it("from the arrival date on, the daily rhythm runs: weatherwarn + evening, arrival once, finale on the last day", async () => {
    bigApple();
    const posts = await sweep("2026-08-26", "2026-08-31");
    const byDay = (day: string) => posts.filter((p) => p.day === day).map((p) => p.kind).sort();

    // "reminder" is the Outdoor Tavern booking at 19:00 on 26.8 — it carries coordinates, and
    // before ORB-127 the scheduler's own header regex could not see a block with an `at:` field
    // at all, so it produced no reminder whatsoever.
    expect(byDay("2026-08-26")).toEqual(["arrival", "evening", "reminder", "weatherwarn"]);
    expect(byDay("2026-08-27")).toEqual(["evening", "weatherwarn"]);
    expect(byDay("2026-08-30")).toEqual(["evening", "weatherwarn"]);
    // Last day: finale replaces the evening post, and checkout is gated on trip.md's wording.
    expect(byDay("2026-08-31")).toEqual(["finale", "weatherwarn"]);
    expect(posts.filter((p) => p.kind === "arrival")).toHaveLength(1);
  });

  it("fires each pre-trip post exactly once, however many times the day is ticked", async () => {
    bigApple();
    const first = await sweep("2026-08-23", "2026-08-25");
    // Ticking the same days again with the SAME sent.json must add nothing.
    const recorder = newRecorder();
    for (const iso of ["2026-08-23", "2026-08-25"]) {
      for (const hour of ["18:00", "18:01", "19:00"]) {
        const at = Math.floor(new Date(`${iso}T${hour}:00Z`).getTime() / 1000);
        await new TripScheduler(makeDeps(() => at, recorder)).tick();
      }
    }
    expect(first).toHaveLength(2);
    expect(recorder.postCalls).toHaveLength(0);
  });

  it("keeps the new post keys in the existing sent.json namespace, so a running box is not confused", async () => {
    const trip = bigApple();
    await sweep("2026-08-23", "2026-08-25");
    const sent = JSON.parse(fs.readFileSync(path.join(trip.dir, "sent.json"), "utf8")) as Record<string, boolean>;
    expect(sent["2026-08-23:packing"]).toBe(true);
    expect(sent["2026-08-25:departure"]).toBe(true);
    // Same `<dateISO>:<kind>` shape as every key already on disk — nothing else was invented.
    for (const key of Object.keys(sent)) expect(key).toMatch(/^\d{4}-\d{2}-\d{2}:[a-z]+(:\S+)?$/);
  });

  it("still fires reminders on days that now post nothing — reminders were to be left alone", async () => {
    const trip = bigApple();
    // A booking on 22.8 at 12:00 — a day before the packing post, on which the new rhythm posts
    // nothing at all. Its reminder (T-1h = 11:00) must still arrive. This is why the evaluation
    // window in TripScheduler.tick was deliberately NOT narrowed alongside the post gates.
    fs.appendFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:early kind:restaurant start:2026-08-22 end:- time:12:00 -->\n- ?\n<!-- /booking -->\n",
    );
    const recorder = newRecorder();
    const at = Math.floor(new Date("2026-08-22T15:00:00Z").getTime() / 1000); // 17:00 Oslo
    await new TripScheduler(makeDeps(() => at, recorder)).tick();
    expect(recorder.postCalls.map((c) => c.kind)).toEqual(["reminder"]);
  });
});

// ─── ORB-127/128 — reminders: which bookings are seen, and on whose clock ──────────────────

describe("reminders for bookings that carry coordinates (ORB-127)", () => {
  it("fires for a block with an at: field — the header regex used to be blind to those", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    // The real shape of every restaurant block filed since ORB-109.
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:withcoords kind:restaurant start:2026-07-22 end:- time:20:00 at:48.8566,2.3522 -->\n" +
        "- Outdoor Tavern Dining. Cancellations at least 3 hours in advance.\n<!-- /booking -->\n",
    );
    const recorder = newRecorder();
    // 19:00 = T-1h for a 20:00 restaurant booking.
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "19:00"), recorder)).tick();

    const reminders = recorder.postCalls.filter((c) => c.kind === "reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.ctx.bookingId).toBe("withcoords");
  });

  it("fires for a block carrying provider: too — ORB-105's field was equally invisible", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:withprovider kind:restaurant start:2026-07-22 end:- time:20:00 provider:Cosme -->\n" +
        "- Table for 2.\n<!-- /booking -->\n",
    );
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "19:00"), recorder)).tick();
    expect(recorder.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(1);
  });

  it("still fires for a bare header, which is all that ever worked before", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:bare kind:flight start:2026-07-22 end:- time:20:00 -->\n- SK455.\n<!-- /booking -->\n",
    );
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "19:00"), recorder)).tick();
    expect(recorder.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(1);
  });

  it("still ignores a booking with no known time", async () => {
    const trip = makeTrip({ start: "2026-07-21", end: "2026-07-25" });
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      "<!-- booking id:notime kind:stay start:2026-07-22 end:2026-07-23 time:- at:48.8566,2.3522 -->\n- Hotel.\n<!-- /booking -->\n",
    );
    const recorder = newRecorder();
    await new TripScheduler(makeDeps(() => ts("2026-07-22", "19:00"), recorder)).tick();
    expect(recorder.postCalls.filter((c) => c.kind === "reminder")).toHaveLength(0);
  });
});

describe("bookingTimezone (ORB-128)", () => {
  const trip = {
    slug: "big-apple", name: "The Big Apple", start: "2026-08-25", end: "2026-08-31",
    timezone: "America/New_York", destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    dir: "/nowhere",
  };
  const HOME = "Europe/Oslo";
  const ARRIVAL = "2026-08-26";

  it("puts a booking AT the destination on the trip clock", () => {
    // The Outdoor Tavern dinner, 26.8 20:00 — a New York time.
    expect(bookingTimezone({ lat: 40.73846, lon: -73.98851, startISO: "2026-08-26" }, trip, ARRIVAL, HOME))
      .toBe("America/New_York");
  });

  it("puts a booking at HOME on the home clock, even on the arrival date", () => {
    // The Gardermoen hotel, 5,700 km from the destination.
    expect(bookingTimezone({ lat: 60.18575, lon: 11.06517, startISO: "2026-08-26" }, trip, ARRIVAL, HOME))
      .toBe(HOME);
  });

  it("treats an un-located booking ON the arrival date as home-side — the travel day starts at home", () => {
    // The airport parking (07:00) and SK455 (09:00) are Oslo times on the arrival date, and
    // carry no coordinates. Read on the New York clock, SK455's reminder came out at 12:00
    // Oslo — three hours after departure.
    expect(bookingTimezone({ startISO: "2026-08-26" }, trip, ARRIVAL, HOME)).toBe(HOME);
    expect(bookingTimezone({ startISO: "2026-08-25" }, trip, ARRIVAL, HOME)).toBe(HOME);
  });

  it("treats an un-located booking AFTER the arrival date as destination-side", () => {
    expect(bookingTimezone({ startISO: "2026-08-27" }, trip, ARRIVAL, HOME)).toBe("America/New_York");
  });
});

describe("a reminder runs on its own booking's clock (ORB-128)", () => {
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  function bigApple(): Trip {
    const trip = store.createTrip({
      slug: "clocks-2026", name: "The Big Apple",
      start: "2026-08-25", end: "2026-08-31", timezone: "America/New_York",
      destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    });
    store.linkChat(trip.slug, "555");
    fs.writeFileSync(
      path.join(trip.dir, "bookings.md"),
      // Arrival anchor + the two real Oslo-time morning bookings on the arrival date.
      "<!-- booking id:dinner kind:restaurant start:2026-08-26 end:- time:20:00 at:40.73846,-73.98851 -->\n- Tavern.\n<!-- /booking -->\n" +
        "<!-- booking id:parking kind:car start:2026-08-26 end:2026-08-31 time:07:00 -->\n- P2 parking, Oslo.\n<!-- /booking -->\n",
    );
    return { ...trip, chatId: "555" };
  }

  beforeEach(() => {
    store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, homeTimezone: "Europe/Oslo", trips: [] });
  });

  it("fires the Oslo-side morning reminder at 07:00 OSLO — which is 01:00 in New York", async () => {
    bigApple();
    const recorder = newRecorder();
    // The parking is at 07:00 Oslo; T-1h is 06:00, which reminderFireTime floors up to the
    // 07:00 reminder floor. 07:00 Oslo on 26.8 = 01:00 New York — so a scheduler reading this
    // booking on the trip clock cannot fire here at all, which is the whole point.
    await new TripScheduler(makeDeps(() => at("2026-08-26T05:00:00Z"), recorder)).tick();

    expect(recorder.postCalls.filter((c) => c.kind === "reminder").map((r) => r.ctx.bookingId)).toEqual(["parking"]);
  });

  it("would not have been due until 13:00 Oslo on the trip clock — six hours after the plane left", async () => {
    bigApple();
    // Same booking, judged the old way: 07:00 in New York is 13:00 in Oslo. SK455 departs Oslo
    // at 09:00. Asserted as arithmetic on the two clocks rather than by resurrecting the bug.
    const osloAt0700 = at("2026-08-26T05:00:00Z");
    const newYorkAt0700 = at("2026-08-26T11:00:00Z");
    expect(newYorkAt0700 - osloAt0700).toBe(6 * 3600);
  });

  it("fires the New York dinner reminder on the New York clock", async () => {
    bigApple();
    const recorder = newRecorder();
    // 19:00 New York on 26.8 = 01:00 Oslo on 27.8. T-1h for a 20:00 booking.
    await new TripScheduler(makeDeps(() => at("2026-08-26T23:00:00Z"), recorder)).tick();
    expect(recorder.postCalls.filter((c) => c.kind === "reminder").map((r) => r.ctx.bookingId)).toContain("dinner");
  });
});

// ─── ORB-123 — a trip with no linked chat is skipped, out loud ────────────────────────────

describe("TripScheduler.tick — a trip with no linked chat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips every post and logs once, rather than posting blind", async () => {
    // Deliberately NOT linked: store.createTrip without the linkChat() that makeTrip() does.
    // A unique slug keeps this independent of the module-level once-per-trip-per-day log guard.
    store.createTrip({
      slug: "chatless-2026",
      name: "Chatless",
      start: "2026-07-21",
      end: "2026-07-25",
      timezone: "UTC",
      destination: { name: "Nowhere", lat: 0, lon: 0 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const recorder = newRecorder();
    // 20:00 inside the window — an evening post would be due if the trip had a chat.
    const scheduler = new TripScheduler(makeDeps(() => ts("2026-07-22", "20:00"), recorder));
    await scheduler.tick();
    await scheduler.tick();

    expect(recorder.postCalls).toHaveLength(0);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chatless-2026"));
    expect(lines).toHaveLength(1); // once, not once per tick
    expect(lines[0]).toContain("no linked chat");
  });

  it("says nothing at all about a chat-less trip that is nowhere near its window", async () => {
    store.createTrip({
      slug: "chatless-far-2027",
      name: "Chatless, far off",
      start: "2027-07-21",
      end: "2027-07-25",
      timezone: "UTC",
      destination: { name: "Nowhere", lat: 0, lon: 0 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new TripScheduler(makeDeps(() => ts("2026-07-22", "20:00"), newRecorder())).tick();

    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chatless-far-2027"))).toHaveLength(0);
  });
});

// ─── agent/schedules/trip-lifecycle.ts — the eve wrapper itself ───────────────────────────

describe("agent/schedules/trip-lifecycle.ts default export", () => {
  const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "MARCEL_DATA_ROOT", "MARCEL_ADMIN_TELEGRAM_ID"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("carries the documented every-minute cron cadence", async () => {
    const mod = await import("../agent/schedules/trip-lifecycle.js");
    expect(mod.default.cron).toBe("* * * * *");
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("stamps the destination chat onto the auth it sends with — ORB-123, the whole bug", async () => {
    // The scheduled turn must run as the chat, not as the app: every trip-aware tool resolves
    // its trip from auth.current.attributes.chat_id. With appAuth's empty attributes they all
    // returned null inside a post, which is what produced the "no trip linked to this chat"
    // message posted INTO the linked chat on 2026-08-19.
    const trip = makeTrip({ slug: "auth-2026", name: "Auth" });
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["MARCEL_DATA_ROOT"] = root;
    // 2026-07-22 20:00 UTC — evening (and the day's 08:30 weatherwarn catch-up) are due.
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const sends: { target: unknown; message: string; options: { auth?: { attributes?: Record<string, unknown> } } }[] = [];
    const to = (_channel: unknown, target: unknown) => ({
      send: async (message: string, options: { auth?: { attributes?: Record<string, unknown> } }) => {
        sends.push({ target, message, options });
      },
    });

    const mod = await import("../agent/schedules/trip-lifecycle.js");
    const appAuth = { attributes: {}, authenticator: "app", principalId: "eve:app", principalType: "runtime" };
    await mod.default.run!({ to: to as never, waitUntil: () => {}, appAuth: appAuth as never });

    expect(sends.length).toBeGreaterThan(0);
    for (const sent of sends) {
      expect(sent.target).toEqual({ chatId: trip.chatId });
      expect(sent.options.auth?.attributes?.["chat_id"]).toBe(trip.chatId);
    }

    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("chatScopedAuth keeps every other appAuth field, so eve still sees an app-initiated turn", async () => {
    const { chatScopedAuth } = await import("../agent/schedules/trip-lifecycle.js");
    const appAuth = {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    } as const;

    const scoped = chatScopedAuth(appAuth, "-5405035031");

    expect(scoped.attributes["chat_id"]).toBe("-5405035031");
    // A string, not a number: agent/instructions/trip-context.ts only accepts it as a string.
    expect(typeof scoped.attributes["chat_id"]).toBe("string");
    expect(scoped.authenticator).toBe("app");
    expect(scoped.principalId).toBe("eve:app");
    expect(scoped.principalType).toBe("runtime");
    // The caller's own auth object is never mutated.
    expect(appAuth.attributes).toEqual({});
  });

  it("is a complete no-op when the gate is off — no TripStore root, no secrets, nothing configured, and it still resolves cleanly", async () => {
    // Gate off (EVE_SCHEDULES_LIVE deleted above). If `run` touched TripStore, Telegram
    // credentials, or the flights client at all, this would throw or hit the filesystem in
    // ways this sandbox doesn't have — a clean resolve is the proof of zero calls.
    const mod = await import("../agent/schedules/trip-lifecycle.js");
    await expect(
      mod.default.run!({ to: (() => {}) as never, waitUntil: () => {}, appAuth: {} as never }),
    ).resolves.toBeUndefined();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});
