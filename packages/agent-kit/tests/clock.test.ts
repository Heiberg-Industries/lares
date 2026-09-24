import { describe, it, expect } from "vitest";

import { buildClockMarkdown } from "../src/clock.js";

/**
 * The reminder that started this (2026-08-17): Bendik said "i morgen" at 22:43 on the 17th,
 * Saga confirmed "i morgen kl. 07:00", and stored 2026-08-20 — two days out. She had no clock
 * at all: eve injects no date, `defineAgent` declares none, `instructions.md` is static, and
 * unlike eve-marcel she had no `agent/instructions/` resolver. `remind_set` delegates date
 * arithmetic to the model by design, so the absolute date came from training priors, and the
 * tool's guard only rejects dueAt in the PAST — a wrong guess landing in the future is stored
 * silently.
 */
describe("buildClockMarkdown — the clock Saga never had", () => {
  // 2026-08-17 22:43 Oslo (CEST, UTC+2) — the exact moment of the bug.
  const theMoment = new Date("2026-08-17T20:43:30Z");

  it("states today's date in Oslo, so 'i morgen' has something to be relative to", () => {
    const md = buildClockMarkdown(theMoment);
    expect(md).toContain("2026-08-17");
  });

  it("names the weekday — 'på fredag' needs to know what day it is now", () => {
    expect(buildClockMarkdown(theMoment)).toMatch(/Monday/);
  });

  it("gives the wall-clock time, for 'om en time' and for a same-day dueAt", () => {
    expect(buildClockMarkdown(theMoment)).toContain("22:43");
  });

  it("names the timezone explicitly — an unlabelled time invites a UTC/local mix-up", () => {
    expect(buildClockMarkdown(theMoment)).toContain("Europe/Oslo");
  });

  it("carries the UTC instant too, so an ISO dueAt can be computed without guessing the offset", () => {
    expect(buildClockMarkdown(theMoment)).toContain("2026-08-17T20:43:30");
  });

  it("crosses midnight in Oslo correctly — the date is Oslo's, not UTC's", () => {
    // 22:30 UTC on the 17th is already 00:30 on the 18th in Oslo (CEST). A UTC-derived date
    // would say the 17th and make every late-night 'i morgen' a day early.
    const lateNight = new Date("2026-08-17T22:30:00Z");
    const md = buildClockMarkdown(lateNight);
    expect(md).toContain("2026-08-18");
    expect(md).toContain("00:30");
  });

  it("handles winter time — the offset is not hardcoded to +02:00", () => {
    // 2026-01-15 is CET (UTC+1): 23:30Z is 00:30 on the 16th.
    const winter = new Date("2026-01-15T23:30:00Z");
    expect(buildClockMarkdown(winter)).toContain("2026-01-16");
  });
});

describe("formatOsloDateTime — what a reminder must confirm back", () => {
  it("renders the stored instant as an absolute Oslo date and time", async () => {
    const { formatOsloDateTime } = await import("../src/clock.js");
    // The bug's actual stored value: 2026-08-20 07:00 Oslo.
    expect(formatOsloDateTime(new Date("2026-08-20T05:00:00Z"))).toBe("Thursday 2026-08-20 07:00 (Europe/Oslo)");
  });

  it("is what makes a wrong date visible — the day the user MEANT reads differently", async () => {
    const { formatOsloDateTime } = await import("../src/clock.js");
    // Had the confirmation said this instead of "i morgen", the two-day error was obvious.
    expect(formatOsloDateTime(new Date("2026-08-18T05:00:00Z"))).toBe("Tuesday 2026-08-18 07:00 (Europe/Oslo)");
  });
});

/**
 * ORB-193 final review — the confirmation must speak the OWNER's clock, not the home one.
 *
 * `buildClockMarkdown` already takes the owner tz, so on a New York trip the turn tells the model it
 * is 15:00 there. A confirmation card still rendering Europe/Oslo would describe the same instant on
 * a second clock inside one exchange — the ORB-124/128/204 class, where a "tonight" stops meaning
 * anything. Both zones are NAMED in the output either way.
 */
describe("formatDateTimeIn — the same instant on the owner's clock", () => {
  it("renders a stored instant in a given zone, naming it", async () => {
    const { formatDateTimeIn } = await import("../src/clock.js");
    const due = new Date("2026-08-20T05:00:00Z");
    expect(formatDateTimeIn(due, "America/New_York")).toBe("Thursday 2026-08-20 01:00 (America/New_York)");
    expect(formatDateTimeIn(due, "Europe/Oslo")).toBe("Thursday 2026-08-20 07:00 (Europe/Oslo)");
  });

  it("crosses the date line where the zone does — a New York evening is the next Oslo day", async () => {
    const { formatDateTimeIn } = await import("../src/clock.js");
    // 2026-08-20 23:30 New York is already the 21st in Oslo. Confirming the wrong one of these two
    // is exactly the failure the reminder clock exists to prevent.
    const due = new Date("2026-08-21T03:30:00Z");
    expect(formatDateTimeIn(due, "America/New_York")).toBe("Thursday 2026-08-20 23:30 (America/New_York)");
    expect(formatDateTimeIn(due, "Europe/Oslo")).toBe("Friday 2026-08-21 05:30 (Europe/Oslo)");
  });

  it("formatOsloDateTime is the same function on the home clock", async () => {
    const { formatDateTimeIn, formatOsloDateTime } = await import("../src/clock.js");
    const due = new Date("2026-08-20T05:00:00Z");
    expect(formatOsloDateTime(due)).toBe(formatDateTimeIn(due, "Europe/Oslo"));
    expect(formatDateTimeIn(due)).toBe(formatOsloDateTime(due)); // the default is the home clock
  });
});

describe("the clock and the prompt cache", () => {
  const tz = "Europe/Oslo";
  const at = (iso: string) => new Date(iso);

  it("changes its bytes every minute at today's default — the finding, pinned", () => {
    // eve merges every dynamic instruction into ONE system message with a single Anthropic
    // cache breakpoint at its end (eve 0.32 dist: harness/tool-loop.js's mergeSystemInstructions
    // + harness/prompt-cache.js's applySystemCacheBreakpoint). A prefix cache is byte-exact, so
    // while this is true the persona, the tool list and the memory block are re-billed on
    // every turn. This test is the evidence, not a wish.
    expect(buildClockMarkdown(at("2026-09-18T12:00:10Z"), tz))
      .not.toBe(buildClockMarkdown(at("2026-09-18T12:01:10Z"), tz));
  });

  it("is byte-identical across a whole owner-day at day precision", () => {
    const a = buildClockMarkdown(at("2026-09-18T06:00:00Z"), tz, "day");
    const b = buildClockMarkdown(at("2026-09-18T19:59:00Z"), tz, "day");
    expect(a).toBe(b);
    expect(a).not.toContain(":"); // no HH:MM, and no UTC instant
  });

  it("changes exactly once at the owner's midnight, not at UTC's", () => {
    // 2026-09-18 23:30 Oslo is 21:30Z; 2026-09-19 00:30 Oslo is 22:30Z.
    expect(buildClockMarkdown(at("2026-09-18T21:30:00Z"), tz, "day"))
      .not.toBe(buildClockMarkdown(at("2026-09-18T22:30:00Z"), tz, "day"));
    expect(buildClockMarkdown(at("2026-09-18T21:30:00Z"), tz, "day"))
      .toBe(buildClockMarkdown(at("2026-09-18T12:00:00Z"), tz, "day"));
  });

  it("is byte-identical within one owner-hour at hour precision, and names the hour honestly", () => {
    const a = buildClockMarkdown(at("2026-09-18T12:00:00Z"), tz, "hour");
    expect(a).toBe(buildClockMarkdown(at("2026-09-18T12:59:00Z"), tz, "hour"));
    expect(a).toMatch(/between 14:00 and 15:00/);
  });

  it("says the same date and weekday at every precision", () => {
    for (const p of ["minute", "hour", "day"] as const) {
      expect(buildClockMarkdown(at("2026-09-18T12:00:00Z"), tz, p)).toContain("2026-09-18");
      expect(buildClockMarkdown(at("2026-09-18T12:00:00Z"), tz, p)).toMatch(/Friday/);
    }
  });
});

/**
 * ORB-193 — the block takes the OWNER's timezone, not a constant. Saga's per-turn resolver passes
 * `await ownerTz()` (`services/chief-of-staff/agent/instructions/clock.ts`), so on a New York trip the
 * date, the weekday and the time she states are the ones Bendik would read off his own phone. The
 * default stays `Europe/Oslo`, which is why every case above is untouched.
 */
describe("buildClockMarkdown(now, tz) — the clock follows the owner (ORB-193)", () => {
  // 02:30Z on 2026-09-09 is 04:30 in Oslo (CEST) and still 22:30 on the 8th in New York.
  const instant = new Date("2026-09-09T02:30:00Z");

  it("names the timezone it was given, and reads the wall clock in it", () => {
    const md = buildClockMarkdown(instant, "America/New_York");
    expect(md).toContain("America/New_York");
    expect(md).not.toContain("Europe/Oslo");
    expect(md).toContain("22:30");
  });

  it("states the owner's DATE, which is a different day from Oslo's at that instant", () => {
    expect(buildClockMarkdown(instant, "America/New_York")).toContain("2026-09-08");
    expect(buildClockMarkdown(instant)).toContain("2026-09-09"); // the Oslo default, unchanged
  });

  it("states the owner's weekday too — 'på fredag' is relative to where he is", () => {
    expect(buildClockMarkdown(instant, "America/New_York")).toMatch(/Tuesday/);
    expect(buildClockMarkdown(instant)).toMatch(/Wednesday/);
  });
});
