import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { DELIVERY_KINDS } from "@lares/agent-kit/delivery";
import { OWNER_FACING_SCHEDULES } from "../lib/schedule-hours";
import {
  DELIVERY_KIND_LIST, ITEM_PREFIX, defaultDelivery, deliveryFromGrid, doorsFromRanks, gridFrom, ranksOf, withStartingDelivery,
} from "../lib/delivery";
import {
  HOURLY_KINDS, briefConflicts, doorFor, hourInQuietWindow, quietWindowFor, type RoutingFact,
} from "../lib/delivery-check";

describe("the grid model", () => {
  it("pre-fills every kind with what happens today when nothing is saved", () => {
    const rows = gridFrom(undefined);
    expect(rows.map((r) => r.kind)).toEqual(Object.keys(DELIVERY_KINDS));
    expect(rows.find((r) => r.kind === "morning-brief")).toMatchObject({ doors: ["telegram"], fromToday: true, label: "Morning brief" });
    expect(rows.find((r) => r.kind === "email-triage")).toMatchObject({ doors: ["slack"], fromToday: true });
  });

  it("shows saved rows as saved and leaves a kind missing from a saved map on today's door", () => {
    const rows = gridFrom({ "morning-brief": ["web", "telegram"] });
    expect(rows.find((r) => r.kind === "morning-brief")).toMatchObject({ doors: ["web", "telegram"], fromToday: false });
    expect(rows.find((r) => r.kind === "digest")).toMatchObject({ doors: ["slack"], fromToday: true });
  });

  it("saves every kind, so the grid and the stored map agree", () => {
    const map = deliveryFromGrid(gridFrom(undefined));
    expect(Object.keys(map).sort()).toEqual(Object.keys(DELIVERY_KINDS).sort());
    expect(map["reminders"]).toEqual(["telegram"]);
  });

  it("turns numbers back into an ordered list, and says what is wrong in plain words", () => {
    expect(doorsFromRanks("Digest", { web: 2, slack: 1, telegram: 0 })).toEqual({ ok: true, doors: ["slack", "web"] });
    expect(doorsFromRanks("Digest", ranksOf(["telegram", "web"]))).toEqual({ ok: true, doors: ["telegram", "web"] });
    expect(doorsFromRanks("Digest", { web: 0, slack: 0, telegram: 0 })).toEqual({ ok: false, message: "Digest: pick a first door." });
    expect(doorsFromRanks("Digest", { web: 1, slack: 1, telegram: 0 })).toEqual({ ok: false, message: "Digest: two doors are both marked 1st." });
    expect(doorsFromRanks("Digest", { web: 2, slack: 0, telegram: 0 })).toEqual({
      ok: false, message: expect.stringContaining("no 1st choice"),
    });
  });

  it("a new agent: first chat door then web chat; web chat alone with no chat door", () => {
    expect(defaultDelivery(["telegram", "slack"])["morning-brief"]).toEqual(["telegram", "web"]);
    expect(defaultDelivery([])["digest"]).toEqual(["web"]);
  });

  it("a newly created chief of staff gets the default; an existing one, or another role, is left alone", () => {
    const def = { doors: [{ kind: "telegram" }, { kind: "email" }], channels: ["telegram"] };
    expect(withStartingDelivery(def, "chief-of-staff", true).delivery?.["morning-brief"]).toEqual(["telegram", "web"]);
    expect(withStartingDelivery({ doors: [], channels: [] }, "chief-of-staff", true).delivery?.["digest"]).toEqual(["web"]);
    expect(withStartingDelivery(def, "chief-of-staff", false)).toBe(def);
    expect(withStartingDelivery(def, "creative", true)).toBe(def);
    const chosen = { ...def, delivery: { digest: ["slack"] } };
    expect(withStartingDelivery(chosen, "chief-of-staff", true)).toBe(chosen);
  });

  it("knows an item-key prefix for every kind (the ledger lookup behind the fallback sentence)", () => {
    expect(Object.keys(ITEM_PREFIX).sort()).toEqual([...DELIVERY_KIND_LIST].sort());
  });

  it("the hour-setting schedules the check covers are exactly the ones the hours control offers", () => {
    expect(Object.keys(HOURLY_KINDS).sort()).toEqual(OWNER_FACING_SCHEDULES.map((s) => s.schedule).sort());
  });
});

describe("quiet-hours check", () => {
  const telegramOn: RoutingFact["doors"] = [{ kind: "telegram", enabled: true }, { kind: "slack", enabled: true }];
  const fact = (delivery: RoutingFact["delivery"] = undefined, doors = telegramOn): RoutingFact => ({ agent: "chief", delivery, doors });
  const base = {
    rows: [], knownDoors: ["telegram:123", "slack:U1", "web:inbox"], hours: { "morning-brief": [6], "evening-brief": [20], digest: [9, 17] },
  };

  it("a window that crosses midnight covers the evening and the early morning, not the day", () => {
    const w = { start: "21:00", end: "07:00" };
    expect([20, 21, 23, 0, 6, 7, 12].map((h) => hourInQuietWindow(h, w))).toEqual([false, true, true, true, true, false, false]);
  });

  it("refuses a morning brief at 06:00 to Telegram under the default 21:00-07:00, in plain words", () => {
    const [sentence, ...rest] = briefConflicts({ ...base, facts: [fact()] });
    expect(rest).toEqual([]);
    expect(sentence).toBe(
      "Morning brief is set for 06:00, but it goes to Telegram and Telegram's quiet hours run 21:00 to 07:00, " +
      "so it would be held back every day. Choose an hour outside quiet hours, or change where it goes.",
    );
  });

  it("an hour outside the window is fine", () => {
    expect(briefConflicts({ ...base, hours: { ...base.hours, "morning-brief": [8] }, facts: [fact()] })).toEqual([]);
  });

  it("follows where the brief goes: the same hour is fine to a door with a different window", () => {
    const rows = [{ agent: "*", door: "web:inbox", quietStart: "22:00", quietEnd: "06:00" }];
    // web chat's own window is 22:00-06:00 -> 06:00 is allowed there, and refused on Telegram
    expect(briefConflicts({ ...base, rows, facts: [fact({ "morning-brief": ["web"] })] })).toEqual([]);
    expect(briefConflicts({ ...base, rows, facts: [fact({ "morning-brief": ["telegram", "web"] })] })).toHaveLength(1);
  });

  it("uses the first listed door that is switched on, else web chat", () => {
    const off = [{ kind: "telegram", enabled: false }];
    expect(doorFor(fact({ "morning-brief": ["telegram", "web"] }, off), "morning-brief")).toBe("web");
    expect(doorFor(fact({ "morning-brief": ["slack", "telegram"] }), "morning-brief")).toBe("slack");
    // no map: today's door, then web chat when that door is off
    expect(doorFor(fact(undefined), "morning-brief")).toBe("telegram");
    expect(doorFor(fact(undefined, off), "morning-brief")).toBe("web");
    expect(briefConflicts({ ...base, facts: [fact(undefined, off)] })[0]).toContain("goes to web chat");
  });

  it("the most specific stored window wins, the way the gate resolves it", () => {
    const rows = [
      { agent: "*", door: "*", quietStart: "22:00", quietEnd: "08:00" },
      { agent: "*", door: "telegram:123", quietStart: "20:00", quietEnd: "04:00" },
    ];
    expect(quietWindowFor(rows, "chief", "telegram:123")).toEqual({ start: "20:00", end: "04:00" });
    expect(quietWindowFor(rows, "chief", "slack:U1")).toEqual({ start: "22:00", end: "08:00" });
    expect(quietWindowFor([], "chief", "slack:U1")).toEqual({ start: "21:00", end: "07:00" });
  });

  it("can look at one schedule or one door only", () => {
    const hours = { ...base.hours, "evening-brief": [22] };
    expect(briefConflicts({ ...base, hours, facts: [fact()], onlySchedules: ["morning-brief"] })).toHaveLength(1);
    expect(briefConflicts({ ...base, hours, facts: [fact()], onlySchedules: ["digest"] })).toEqual([]);
    expect(briefConflicts({ ...base, hours, facts: [fact()], onlyDoorId: "slack:U1" })).toEqual([]);
    expect(briefConflicts({ ...base, hours, facts: [fact()], onlyDoorId: "telegram:123" })).toHaveLength(2);
  });
});
