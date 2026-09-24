import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * LAR-17-s5 — unit coverage for the two halves of "when do the agents speak":
 *
 *   - `lib/schedule-hours.ts` — the database-free mirror (`SCHEDULE_HOUR_DEFAULTS`, `SINGLE_SLOT`,
 *     `OWNER_FACING_SCHEDULES`, `validateHours`), pinned against the kit's own source by
 *     `tests/engine-drift.test.ts`; this file is its behavioural coverage.
 *   - `lib/schedule-settings.ts` — the server-only read layer, whose missing-table degradation is
 *     the same shape `lib/brief-settings.ts`'s `readBriefLanguage` already has coverage for via
 *     `tests/proactivity-page.test.tsx`.
 */
import {
  isOwnerFacingSchedule, OWNER_FACING_SCHEDULES, SCHEDULE_HOUR_DEFAULTS, SINGLE_SLOT, validateHours,
} from "../lib/schedule-hours";

describe("SCHEDULE_HOUR_DEFAULTS / SINGLE_SLOT (lib/schedule-hours.ts)", () => {
  it("carries the engine default for every schedule the kit knows", () => {
    expect(SCHEDULE_HOUR_DEFAULTS).toEqual({
      "morning-brief": [8],
      "evening-brief": [20],
      digest: [9, 17],
      "crm-routing": [9, 13, 17],
      "weekly-summary": [9],
      "voice-learn": [4],
      dream: [3],
    });
  });

  it("SINGLE_SLOT is every schedule except digest and crm-routing", () => {
    expect(SINGLE_SLOT.has("morning-brief")).toBe(true);
    expect(SINGLE_SLOT.has("evening-brief")).toBe(true);
    expect(SINGLE_SLOT.has("weekly-summary")).toBe(true);
    expect(SINGLE_SLOT.has("voice-learn")).toBe(true);
    expect(SINGLE_SLOT.has("dream")).toBe(true);
    expect(SINGLE_SLOT.has("digest")).toBe(false);
    expect(SINGLE_SLOT.has("crm-routing")).toBe(false);
  });
});

describe("OWNER_FACING_SCHEDULES / isOwnerFacingSchedule", () => {
  it("offers exactly the five owner-facing schedules — dream and voice-learn are left out", () => {
    expect(OWNER_FACING_SCHEDULES.map((s) => s.schedule)).toEqual([
      "morning-brief", "evening-brief", "digest", "crm-routing", "weekly-summary",
    ]);
  });

  it("isOwnerFacingSchedule is true only for those five", () => {
    for (const { schedule } of OWNER_FACING_SCHEDULES) expect(isOwnerFacingSchedule(schedule)).toBe(true);
    expect(isOwnerFacingSchedule("dream")).toBe(false);
    expect(isOwnerFacingSchedule("voice-learn")).toBe(false);
    expect(isOwnerFacingSchedule("not-a-schedule")).toBe(false);
  });
});

describe("validateHours (lib/schedule-hours.ts) — mirrors the kit's own rules", () => {
  it("accepts every schedule's own engine default", () => {
    for (const [schedule, hours] of Object.entries(SCHEDULE_HOUR_DEFAULTS)) {
      expect(validateHours(schedule, [...hours])).toEqual({ ok: true });
    }
  });

  it("accepts a valid re-ordering of a multi-slot schedule's hours, ascending", () => {
    expect(validateHours("crm-routing", [9, 13, 17])).toEqual({ ok: true });
    expect(validateHours("digest", [6])).toEqual({ ok: true });
  });

  it("refuses an unknown schedule", () => {
    expect(validateHours("sleep-schedule", [9])).toEqual({
      ok: false, message: '"sleep-schedule" is not a known schedule.',
    });
  });

  it("refuses an empty list", () => {
    expect(validateHours("morning-brief", [])).toEqual({
      ok: false, message: "At least one hour is required.",
    });
  });

  it("refuses more than 6 hours", () => {
    expect(validateHours("digest", [0, 1, 2, 3, 4, 5, 6])).toEqual({
      ok: false, message: "At most 6 hours a day are allowed.",
    });
  });

  it("refuses two hours for a single-slot schedule (a brief)", () => {
    expect(validateHours("morning-brief", [8, 9])).toEqual({
      ok: false, message: "morning-brief takes exactly one hour.",
    });
    expect(validateHours("evening-brief", [19, 20])).toEqual({
      ok: false, message: "evening-brief takes exactly one hour.",
    });
    expect(validateHours("weekly-summary", [9, 10])).toEqual({
      ok: false, message: "weekly-summary takes exactly one hour.",
    });
  });

  it("refuses 24 — not a whole hour between 0 and 23", () => {
    expect(validateHours("morning-brief", [24])).toEqual({
      ok: false, message: "24 is not a whole hour between 0 and 23.",
    });
  });

  it("refuses a fractional hour (8.5)", () => {
    expect(validateHours("morning-brief", [8.5])).toEqual({
      ok: false, message: "8.5 is not a whole hour between 0 and 23.",
    });
  });

  it("refuses a negative hour", () => {
    expect(validateHours("morning-brief", [-1])).toEqual({
      ok: false, message: "-1 is not a whole hour between 0 and 23.",
    });
  });

  it("refuses duplicate hours", () => {
    expect(validateHours("digest", [9, 9, 17])).toEqual({
      ok: false, message: "Hours must not repeat.",
    });
  });

  it("refuses an unsorted list rather than sorting it", () => {
    expect(validateHours("digest", [17, 9])).toEqual({
      ok: false, message: "Hours must be sorted, lowest to highest.",
    });
    expect(validateHours("crm-routing", [9, 17, 13])).toEqual({
      ok: false, message: "Hours must be sorted, lowest to highest.",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// lib/schedule-settings.ts — the server-only read layer's degradation.
// ---------------------------------------------------------------------------------------------

const state: { rows: Array<{ schedule: string; hours: number[] }>; fail: boolean } = { rows: [], fail: false };

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (state.fail) throw new Error('relation "schedule_settings" does not exist');
      if (/FROM schedule_settings/i.test(sql)) return { rows: state.rows };
      return { rows: [] };
    }),
  },
}));

beforeEach(() => {
  state.rows = [];
  state.fail = false;
});

describe("readScheduleHoursSettings (lib/schedule-settings.ts)", () => {
  it("reads every owner-facing schedule as its engine default when no rows are stored", async () => {
    const { readScheduleHoursSettings } = await import("../lib/schedule-settings");
    const view = await readScheduleHoursSettings("bendik");
    expect(view.unavailable).toBeUndefined();
    expect(view.rows).toEqual([
      { schedule: "morning-brief", label: "Morning brief", hours: [8], isDefault: true },
      { schedule: "evening-brief", label: "Evening brief", hours: [20], isDefault: true },
      { schedule: "digest", label: "Digest", hours: [9, 17], isDefault: true },
      { schedule: "crm-routing", label: "CRM routing", hours: [9, 13, 17], isDefault: true },
      { schedule: "weekly-summary", label: "Weekly summary", hours: [9], isDefault: true },
    ]);
  });

  it("a stored row overrides the default and is marked non-default", async () => {
    state.rows = [{ schedule: "morning-brief", hours: [7] }];
    const { readScheduleHoursSettings } = await import("../lib/schedule-settings");
    const view = await readScheduleHoursSettings("bendik");
    const row = view.rows.find((r) => r.schedule === "morning-brief")!;
    expect(row).toEqual({ schedule: "morning-brief", label: "Morning brief", hours: [7], isDefault: false });
    // Every other schedule is untouched.
    expect(view.rows.find((r) => r.schedule === "evening-brief")).toEqual({
      schedule: "evening-brief", label: "Evening brief", hours: [20], isDefault: true,
    });
  });

  it("a query failure (including a missing table) degrades to the engine defaults, marked unavailable", async () => {
    state.fail = true;
    const { readScheduleHoursSettings } = await import("../lib/schedule-settings");
    const view = await readScheduleHoursSettings("bendik");
    expect(view.unavailable).toBe(true);
    expect(view.rows.every((r) => r.isDefault)).toBe(true);
    expect(view.rows.find((r) => r.schedule === "digest")?.hours).toEqual([9, 17]);
  });
});
