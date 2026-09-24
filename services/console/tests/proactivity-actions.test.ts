import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ sql: string; params: unknown[] }> = [];
let knownDoors: string[] = ["telegram:123456", "slack:U0ABC"];

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      // The door-scope check (`readDoors`) is the only read these actions make.
      if (/FROM initiations/i.test(sql)) return { rows: knownDoors.map((door) => ({ door })) };
      return { rows: [] };
    }),
  },
}));
vi.mock("../lib/auth", () => ({ verify: vi.fn(async () => "owner@owner.example") }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveDnd, saveQuietHours, saveCeilings, saveBriefLanguage, saveScheduleHours } from "../app/actions/proactivity";

const writes = () => queries.filter((q) => /INSERT INTO proactivity_settings/i.test(q.sql));
const briefWrites = () => queries.filter((q) => /INSERT INTO brief_settings/i.test(q.sql));
const scheduleWrites = () => queries.filter((q) => /INSERT INTO schedule_settings/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  knownDoors = ["telegram:123456", "slack:U0ABC"];
});

describe("saveDnd", () => {
  it("upserts the global row and touches only the dnd column", async () => {
    expect(await saveDnd({ agent: "*", dnd: true })).toEqual({ ok: true });
    const w = writes()[0]!;
    expect(w.sql).toMatch(/ON CONFLICT \(owner, agent, door\)/i);
    expect(w.sql).toMatch(/DO UPDATE SET dnd = EXCLUDED\.dnd/i);
    expect(w.sql).not.toMatch(/quiet_start/i);
    expect(w.params).toEqual(["bendik", "*", true, "owner@owner.example"]);
  });
  it("upserts a per-agent row on the agent scope, door '*'", async () => {
    expect(await saveDnd({ agent: "marcel", dnd: true })).toEqual({ ok: true });
    expect(writes()[0]!.params).toEqual(["bendik", "marcel", true, "owner@owner.example"]);
  });
  it("refuses an unknown agent without writing", async () => {
    const r = await saveDnd({ agent: "nora", dnd: true });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/unknown agent/i) });
    expect(writes()).toHaveLength(0);
  });
  it("reads the owner from AGENT_OWNER_USER_ID when set", async () => {
    process.env.AGENT_OWNER_USER_ID = " ada ";
    try {
      await saveDnd({ agent: "*", dnd: false });
      expect(writes()[0]!.params[0]).toBe("ada");
    } finally {
      process.env.AGENT_OWNER_USER_ID = "bendik"; // restore explicit fixture identity
    }
  });
});

describe("saveQuietHours", () => {
  it("upserts the window for the global door scope", async () => {
    expect(await saveQuietHours({ door: "*", quietStart: "22:00", quietEnd: "08:00" })).toEqual({ ok: true });
    const w = writes()[0]!;
    expect(w.sql).toMatch(/DO UPDATE SET quiet_start = EXCLUDED\.quiet_start/i);
    expect(w.sql).not.toMatch(/dnd/i);
    expect(w.params).toEqual(["bendik", "*", "22:00", "08:00", "owner@owner.example"]);
  });
  it("upserts a per-door window for a door this install has used", async () => {
    expect(await saveQuietHours({ door: "telegram:123456", quietStart: "21:00", quietEnd: "07:00" })).toEqual({ ok: true });
    expect(writes()[0]!.params[1]).toBe("telegram:123456");
  });
  it("refuses a door nothing speaks through — the gate matches the door id exactly", async () => {
    const r = await saveQuietHours({ door: "telegram", quietStart: "21:00", quietEnd: "07:00" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/not a door/i) });
    expect(writes()).toHaveLength(0);
  });
  it("refuses a window under the 8 h engine floor without writing", async () => {
    const r = await saveQuietHours({ door: "*", quietStart: "23:30", quietEnd: "07:00" });
    expect(r.ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });
  it("refuses a malformed time without writing", async () => {
    expect((await saveQuietHours({ door: "*", quietStart: "9pm", quietEnd: "07:00" })).ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});

describe("saveCeilings", () => {
  it("upserts the three numbers and touches only those columns", async () => {
    const r = await saveCeilings({ door: "*", eventPerDoorPerDay: 6, escalationPerDoorPerDay: 2, perOwnerPerDay: 9 });
    expect(r).toEqual({ ok: true });
    const w = writes()[0]!;
    expect(w.sql).toMatch(/event_per_door_per_day = EXCLUDED\.event_per_door_per_day/i);
    expect(w.sql).not.toMatch(/quiet_start/i);
    expect(w.params).toEqual(["bendik", "*", 6, 2, 9, "owner@owner.example"]);
  });
  it("refuses a ceiling above the engine maximum without writing", async () => {
    const r = await saveCeilings({ door: "*", eventPerDoorPerDay: 50, escalationPerDoorPerDay: 2, perOwnerPerDay: 9 });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/engine maximum of 20/i) });
    expect(writes()).toHaveLength(0);
  });
  it("refuses a fractional or negative ceiling without writing", async () => {
    expect((await saveCeilings({ door: "*", eventPerDoorPerDay: 1.5, escalationPerDoorPerDay: 2, perOwnerPerDay: 9 })).ok).toBe(false);
    expect((await saveCeilings({ door: "*", eventPerDoorPerDay: 1, escalationPerDoorPerDay: -2, perOwnerPerDay: 9 })).ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});

describe("saveBriefLanguage", () => {
  it("upserts the row with updated_by", async () => {
    expect(await saveBriefLanguage({ language: "sv" })).toEqual({ ok: true });
    const w = briefWrites()[0]!;
    expect(w.sql).toMatch(/ON CONFLICT \(owner\)/i);
    expect(w.sql).toMatch(/DO UPDATE SET language = EXCLUDED\.language/i);
    expect(w.params).toEqual(["bendik", "sv", "owner@owner.example"]);
  });
  it("refuses an unsupported code without writing", async () => {
    const r = await saveBriefLanguage({ language: "de" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/not a supported brief language/i) });
    expect(briefWrites()).toHaveLength(0);
  });
  it("refuses a malformed code without writing", async () => {
    const r = await saveBriefLanguage({ language: "not-a-code" });
    expect(r.ok).toBe(false);
    expect(briefWrites()).toHaveLength(0);
  });
  it("reads the owner from AGENT_OWNER_USER_ID when set", async () => {
    process.env.AGENT_OWNER_USER_ID = " ada ";
    try {
      await saveBriefLanguage({ language: "fi" });
      expect(briefWrites()[0]!.params[0]).toBe("ada");
    } finally {
      process.env.AGENT_OWNER_USER_ID = "bendik"; // restore explicit fixture identity
    }
  });
});

describe("saveScheduleHours", () => {
  it("upserts a single-slot schedule's hour with updated_by", async () => {
    expect(await saveScheduleHours({ schedule: "morning-brief", hours: [7] })).toEqual({ ok: true });
    const w = scheduleWrites()[0]!;
    expect(w.sql).toMatch(/ON CONFLICT \(owner, schedule\)/i);
    expect(w.sql).toMatch(/DO UPDATE SET hours = EXCLUDED\.hours/i);
    expect(w.params).toEqual(["bendik", "morning-brief", [7], "owner@owner.example"]);
  });
  it("upserts a multi-slot schedule's hours", async () => {
    expect(await saveScheduleHours({ schedule: "crm-routing", hours: [9, 13, 17] })).toEqual({ ok: true });
    expect(scheduleWrites()[0]!.params).toEqual(["bendik", "crm-routing", [9, 13, 17], "owner@owner.example"]);
  });
  it("refuses a schedule this page does not offer (dream, voice-learn) without writing", async () => {
    const r1 = await saveScheduleHours({ schedule: "dream", hours: [3] });
    expect(r1).toEqual({ ok: false, message: expect.stringMatching(/not one of the schedules/i) });
    const r2 = await saveScheduleHours({ schedule: "voice-learn", hours: [4] });
    expect(r2.ok).toBe(false);
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("refuses an unknown schedule name without writing", async () => {
    const r = await saveScheduleHours({ schedule: "sleep-schedule", hours: [9] });
    expect(r.ok).toBe(false);
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("refuses two hours for a single-slot schedule (a brief) without writing", async () => {
    const r = await saveScheduleHours({ schedule: "evening-brief", hours: [19, 20] });
    expect(r).toEqual({ ok: false, message: "evening-brief takes exactly one hour." });
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("refuses 24 without writing", async () => {
    const r = await saveScheduleHours({ schedule: "morning-brief", hours: [24] });
    expect(r).toEqual({ ok: false, message: "24 is not a whole hour between 0 and 23." });
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("refuses a fractional hour (8.5) without writing", async () => {
    const r = await saveScheduleHours({ schedule: "morning-brief", hours: [8.5] });
    expect(r).toEqual({ ok: false, message: "8.5 is not a whole hour between 0 and 23." });
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("refuses duplicate hours without writing", async () => {
    const r = await saveScheduleHours({ schedule: "digest", hours: [9, 9] });
    expect(r).toEqual({ ok: false, message: "Hours must not repeat." });
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("refuses an unsorted list without writing — it is refused, not silently sorted", async () => {
    const r = await saveScheduleHours({ schedule: "digest", hours: [17, 9] });
    expect(r).toEqual({ ok: false, message: "Hours must be sorted, lowest to highest." });
    expect(scheduleWrites()).toHaveLength(0);
  });
  it("reads the owner from AGENT_OWNER_USER_ID when set", async () => {
    process.env.AGENT_OWNER_USER_ID = " ada ";
    try {
      await saveScheduleHours({ schedule: "morning-brief", hours: [8] });
      expect(scheduleWrites()[0]!.params[0]).toBe("ada");
    } finally {
      process.env.AGENT_OWNER_USER_ID = "bendik"; // restore explicit fixture identity
    }
  });
});

describe("authentication", () => {
  it("throws before any write when there is no session", async () => {
    const auth = await import("../lib/auth");
    vi.mocked(auth.verify).mockResolvedValueOnce(null);
    await expect(saveDnd({ agent: "*", dnd: true })).rejects.toThrow(/unauthenticated/);
    expect(writes()).toHaveLength(0);
  });
  it("throws before any write on saveBriefLanguage when there is no session", async () => {
    const auth = await import("../lib/auth");
    vi.mocked(auth.verify).mockResolvedValueOnce(null);
    await expect(saveBriefLanguage({ language: "nb" })).rejects.toThrow(/unauthenticated/);
    expect(briefWrites()).toHaveLength(0);
  });
  it("throws before any write on saveScheduleHours when there is no session", async () => {
    const auth = await import("../lib/auth");
    vi.mocked(auth.verify).mockResolvedValueOnce(null);
    await expect(saveScheduleHours({ schedule: "morning-brief", hours: [8] })).rejects.toThrow(/unauthenticated/);
    expect(scheduleWrites()).toHaveLength(0);
  });
});
