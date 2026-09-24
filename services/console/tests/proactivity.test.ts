import { describe, it, expect } from "vitest";
import {
  ENGINE,
  checkCeilings,
  effectiveCeiling,
  effectiveQuietWindow,
  effectiveSettings,
  validateQuietHours,
  parseHHMM,
  resolveConsoleOwnerClock,
  doorLabel,
  reasonLabel,
  ownerDayIn,
  formatInOwnerTz,
  effectiveDnd,
  foldTodayByDoor,
} from "../lib/proactivity";
import type { TodayRowDTO } from "../lib/proactivity";

describe("parseHHMM", () => {
  it("returns minutes since midnight for a valid HH:MM", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("07:00")).toBe(420);
    expect(parseHHMM("21:00")).toBe(1260);
    expect(parseHHMM("23:59")).toBe(1439);
  });
  it("refuses anything the schema's CHECK would refuse", () => {
    // The kit reads a malformed value as NaN minutes, and every comparison against NaN is false —
    // quiet hours would silently vanish. Same regex as sql/035 and the kit.
    for (const bad of ["", "7:00", "24:00", "23:60", "21:0", "21.00", "2100", "ab:cd", "21:00 ", "-1:00"]) {
      expect(parseHHMM(bad), bad).toBeNull();
    }
  });
});

describe("validateQuietHours", () => {
  it("accepts the engine window", () => {
    expect(validateQuietHours("21:00", "07:00")).toEqual({ ok: true });
  });
  it("accepts a moved window that is still at least the engine floor", () => {
    expect(validateQuietHours("22:00", "08:00").ok).toBe(true); // 10 h
    expect(validateQuietHours("23:00", "07:00").ok).toBe(true); // 8 h exactly
    expect(validateQuietHours("07:00", "15:00").ok).toBe(true); // 8 h, no midnight crossing
  });
  it("refuses a window shorter than the engine floor, across midnight or not", () => {
    const a = validateQuietHours("23:30", "07:00"); // 7.5 h
    expect(a.ok).toBe(false);
    expect(a.ok === false && a.message).toMatch(/8 h|8 hours/i);
    expect(validateQuietHours("05:00", "06:00").ok).toBe(false); // 1 h, no crossing
    expect(validateQuietHours("21:00", "21:00").ok).toBe(false); // an empty window
  });
  it("refuses a malformed time and names which field", () => {
    const s = validateQuietHours("9pm", "07:00");
    expect(s.ok).toBe(false);
    expect(s.ok === false && s.message).toMatch(/start/i);
    const e = validateQuietHours("21:00", "7");
    expect(e.ok).toBe(false);
    expect(e.ok === false && e.message).toMatch(/end/i);
  });
});

describe("checkCeilings", () => {
  it("accepts the engine values themselves", () => {
    const r = checkCeilings({
      eventPerDoorPerDay: ENGINE.eventPerDoorPerDay,
      escalationPerDoorPerDay: ENGINE.escalationPerDoorPerDay,
      perOwnerPerDay: ENGINE.perOwnerPerDay,
    });
    expect(r).toEqual({ ok: true, values: { eventPerDoorPerDay: 20, escalationPerDoorPerDay: 3, perOwnerPerDay: 30 } });
  });
  it("accepts lower values — settings may only lower a ceiling", () => {
    const r = checkCeilings({ eventPerDoorPerDay: 4, escalationPerDoorPerDay: 1, perOwnerPerDay: 6 });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.values.eventPerDoorPerDay).toBe(4);
  });
  it("accepts zero — silence is a legitimate setting", () => {
    expect(checkCeilings({ eventPerDoorPerDay: 0, escalationPerDoorPerDay: 0, perOwnerPerDay: 0 }).ok).toBe(true);
  });
  it("REFUSES a value above the engine max and names the field and the max", () => {
    const r = checkCeilings({ eventPerDoorPerDay: 50, escalationPerDoorPerDay: 3, perOwnerPerDay: 15 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/20/);
    expect(r.ok === false && r.message).toMatch(/event/i);
  });
  it("refuses each ceiling independently", () => {
    expect(checkCeilings({ eventPerDoorPerDay: 10, escalationPerDoorPerDay: 4, perOwnerPerDay: 15 }).ok).toBe(false);
    expect(checkCeilings({ eventPerDoorPerDay: 10, escalationPerDoorPerDay: 3, perOwnerPerDay: 31 }).ok).toBe(false);
  });
  it("refuses a negative or fractional value", () => {
    expect(checkCeilings({ eventPerDoorPerDay: -1, escalationPerDoorPerDay: 3, perOwnerPerDay: 15 }).ok).toBe(false);
    expect(checkCeilings({ eventPerDoorPerDay: 2.5, escalationPerDoorPerDay: 3, perOwnerPerDay: 15 }).ok).toBe(false);
    expect(checkCeilings({ eventPerDoorPerDay: Number.NaN, escalationPerDoorPerDay: 3, perOwnerPerDay: 15 }).ok).toBe(false);
  });
});

describe("resolveConsoleOwnerClock", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  it("uses a fresh Slack-profile signal", () => {
    const c = resolveConsoleOwnerClock(now, {
      homeTz: "Europe/Oslo",
      slackProfile: { tz: "America/New_York", observedAt: new Date("2026-09-08T09:00:00Z") },
    });
    expect(c.tz).toBe("America/New_York");
    expect(c.source).toBe("slack-profile");
    expect(c.detail).toMatch(/3h/);
  });
  it("falls back to home when the signal is older than 24 h", () => {
    const c = resolveConsoleOwnerClock(now, {
      homeTz: "Europe/Oslo",
      slackProfile: { tz: "America/New_York", observedAt: new Date("2026-09-06T09:00:00Z") },
    });
    expect(c.tz).toBe("Europe/Oslo");
    expect(c.source).toBe("home");
    expect(c.detail).toMatch(/stale/i);
  });
  it("ignores a timezone this runtime does not know", () => {
    const c = resolveConsoleOwnerClock(now, { homeTz: "Europe/Oslo", slackProfile: { tz: "Mars/Olympus", observedAt: now } });
    expect(c).toMatchObject({ tz: "Europe/Oslo", source: "home" });
  });
  it("falls back to Europe/Oslo when OWNER_HOME_TZ is unusable", () => {
    expect(resolveConsoleOwnerClock(now, { homeTz: "not/a/zone" }).tz).toBe("Europe/Oslo");
  });
  it("says nothing about a trip — the console cannot see Marcel's trip store", () => {
    // The console container does not mount /srv/eve-marcel (compose.yaml: only /srv/taste), so a
    // trip-set clock is visible on the box and NOT here. The page says so rather than implying home.
    const c = resolveConsoleOwnerClock(now, { homeTz: "Europe/Oslo" });
    expect(c.source).toBe("home");
    expect(c.tripVisible).toBe(false);
  });
});

describe("effectiveCeiling — the kit's clamp, mirrored on READ", () => {
  it("null means the engine default, with nothing to annotate", () => {
    expect(effectiveCeiling(null, ENGINE.eventPerDoorPerDay)).toEqual({ value: 20, stored: null, note: null });
  });
  it("a lowered ceiling is what it says, with nothing to annotate", () => {
    expect(effectiveCeiling(4, ENGINE.eventPerDoorPerDay)).toEqual({ value: 4, stored: null, note: null });
    expect(effectiveCeiling(0, ENGINE.eventPerDoorPerDay)).toEqual({ value: 0, stored: null, note: null });
  });
  it("a row written by hand ABOVE the engine max shows the effective value and says so", () => {
    // The console refuses 50 on write; hand SQL does not. The kit clamps it to 20 on every read, so
    // the page must print 20 — and name the 50, or the annotation is the only place the truth lives.
    expect(effectiveCeiling(50, ENGINE.eventPerDoorPerDay)).toEqual({
      value: 20, stored: 50, note: "stored 50 — the engine uses 20",
    });
    expect(effectiveCeiling(4, ENGINE.escalationPerDoorPerDay).note).toBe("stored 4 — the engine uses 3");
  });
  it("a negative row is floored at 0, as the kit floors it", () => {
    expect(effectiveCeiling(-3, ENGINE.perOwnerPerDay)).toEqual({
      value: 0, stored: -3, note: "stored -3 — the engine uses 0",
    });
  });
});

describe("effectiveQuietWindow — the kit's read-time quiet hours, mirrored", () => {
  it("nothing stored is the engine window, marked as the default", () => {
    expect(effectiveQuietWindow(null, null)).toEqual({
      quietStart: "21:00", quietEnd: "07:00", isDefault: true, note: null,
    });
  });
  it("a moved window at or above the floor stands, and is not the default", () => {
    expect(effectiveQuietWindow("22:00", "08:00")).toEqual({
      quietStart: "22:00", quietEnd: "08:00", isDefault: false, note: null,
    });
    expect(effectiveQuietWindow("23:00", "07:00").note).toBeNull(); // 8 h exactly
  });
  it("one stored half falls back to the engine value for the other, with nothing to annotate", () => {
    expect(effectiveQuietWindow("22:00", null)).toEqual({
      quietStart: "22:00", quietEnd: "07:00", isDefault: false, note: null,
    });
  });
  it("a window under the floor becomes the ENGINE window WHOLESALE, and says so", () => {
    // Not 05:00-13:00 (the owner's start with the end pushed out) — that would silence the whole
    // morning, the opposite of what someone typing 05:00-06:00 asked for.
    expect(effectiveQuietWindow("05:00", "06:00")).toEqual({
      quietStart: "21:00", quietEnd: "07:00", isDefault: false,
      note: "stored 05:00–06:00 is 1.0 h — the engine uses 21:00–07:00",
    });
  });
  it("an empty window (start = end) is under the floor too", () => {
    expect(effectiveQuietWindow("21:00", "21:00").quietStart).toBe("21:00");
    expect(effectiveQuietWindow("21:00", "21:00").note).toMatch(/0\.0 h/);
  });
  it("a malformed cell falls back to its own engine value and names itself", () => {
    const r = effectiveQuietWindow("9pm", "07:00");
    expect(r.quietStart).toBe("21:00");
    expect(r.quietEnd).toBe("07:00");
    expect(r.note).toBe('stored "9pm" is not a 24-hour time — the engine uses 21:00');
  });
});

describe("effectiveSettings", () => {
  it("re-validates all four settings of one stored row", () => {
    const e = effectiveSettings({
      quietStart: "05:00", quietEnd: "06:00",
      eventPerDoorPerDay: 50, escalationPerDoorPerDay: 1, perOwnerPerDay: null,
    });
    expect(e.quiet.quietStart).toBe("21:00");
    expect(e.eventPerDoorPerDay.value).toBe(20);
    expect(e.escalationPerDoorPerDay).toEqual({ value: 1, stored: null, note: null });
    expect(e.perOwnerPerDay.value).toBe(30);
  });
});

describe("effectiveDnd", () => {
  it("is an OR across scopes — a global switch cannot be undone by an agent row", () => {
    expect(effectiveDnd(true, false)).toBe(true);
    expect(effectiveDnd(false, true)).toBe(true);
    expect(effectiveDnd(false, false)).toBe(false);
    expect(effectiveDnd(false, undefined)).toBe(false);
  });
});

describe("labels", () => {
  it("doorLabel reads a door id in plain language and keeps the raw id visible", () => {
    expect(doorLabel("telegram:123456")).toBe("Telegram · 123456");
    expect(doorLabel("slack:U0ABC")).toBe("Slack · U0ABC");
    expect(doorLabel("*")).toBe("All doors");
    expect(doorLabel("weird")).toBe("weird");
  });
  it("reasonLabel says what happened in words, and passes an unknown reason through", () => {
    expect(reasonLabel("quiet-hours")).toMatch(/quiet hours/i);
    expect(reasonLabel("already-seen")).toMatch(/already/i);
    expect(reasonLabel("door-ceiling")).toMatch(/door/i);
    expect(reasonLabel("owner-ceiling")).toMatch(/day/i);
    expect(reasonLabel("dnd")).toMatch(/do not disturb/i);
    expect(reasonLabel("dnd-final-stop")).toMatch(/do not disturb/i);
    expect(reasonLabel(null)).toBe("");
    expect(reasonLabel("something-new")).toBe("something-new");
  });
});

describe("owner-clock formatting", () => {
  it("ownerDayIn gives the owner's calendar day, not the server's", () => {
    // 01:30 UTC on the 9th is still the 8th in New York.
    expect(ownerDayIn(new Date("2026-09-09T01:30:00Z"), "America/New_York")).toBe("2026-09-08");
    expect(ownerDayIn(new Date("2026-09-09T01:30:00Z"), "Europe/Oslo")).toBe("2026-09-09");
  });
  it("formatInOwnerTz renders a ledger row's time on the owner's clock", () => {
    expect(formatInOwnerTz(new Date("2026-09-08T19:05:00Z"), "Europe/Oslo")).toBe("2026-09-08 21:05");
    expect(formatInOwnerTz(new Date("2026-09-08T19:05:00Z"), "America/New_York")).toBe("2026-09-08 15:05");
    expect(formatInOwnerTz(null, "Europe/Oslo")).toBe("");
  });
});

describe("foldTodayByDoor", () => {
  const rows: TodayRowDTO[] = [
    { door: "telegram:1", status: "sent", reason: null, count: 3 },
    { door: "telegram:1", status: "suppressed", reason: "quiet-hours", count: 2 },
    { door: "telegram:1", status: "suppressed", reason: "already-seen", count: 1 },
    { door: "telegram:1", status: "deferred", reason: "door-ceiling", count: 4 },
    { door: "slack:U0ABC", status: "sent", reason: null, count: 1 },
  ];
  it("groups per door, sorted, and sums the sent rows", () => {
    const folded = foldTodayByDoor(rows);
    expect(folded.map((f) => f.door)).toEqual(["slack:U0ABC", "telegram:1"]);
    expect(folded[1]!.sent).toBe(3);
  });
  it("keeps every suppression and deferral reason — a held-back item must never be summed away", () => {
    const tg = foldTodayByDoor(rows)[1]!;
    expect(tg.suppressed.map((r) => r.reason)).toEqual(["quiet-hours", "already-seen"]);
    expect(tg.deferred).toEqual([{ door: "telegram:1", status: "deferred", reason: "door-ceiling", count: 4 }]);
  });
  it("a door with only suppressions still appears, with zero sent", () => {
    const f = foldTodayByDoor([{ door: "slack:C1", status: "suppressed", reason: "dnd", count: 5 }]);
    expect(f).toHaveLength(1);
    expect(f[0]!.sent).toBe(0);
    expect(f[0]!.suppressed[0]!.count).toBe(5);
  });
  it("no rows is no doors", () => {
    expect(foldTodayByDoor([])).toEqual([]);
  });
});
