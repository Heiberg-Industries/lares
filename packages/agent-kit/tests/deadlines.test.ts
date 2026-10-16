import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintYear, jurisdictionFor, statutoryCalendar, parseStatutoryCalendar, daysToDue, mentionsToday, ladderStep, nextDue, MENTION_DAYS } from "../src/deadlines.js";
const TZ = "Europe/Oslo";
const open = (over: Partial<Parameters<typeof ladderStep>[0]> = {}) => ({ id: "d1", title: "VAT return, term 3", source: "statutory" as const, dueDate: "2026-08-31", rung: 0, status: "open" as const, ...over });

// The calendar is installation data. These rules are made up for the tests: eight rules, four of
// them a "vat-*" set that some companies do not have, the rest filed in the year after.
const rule = (key: string, title: string, month: number, day: number, yearOffset: 0 | 1) => ({
  key, title, month, day, yearOffset, recurrence: "yearly", consequence: "A late fee runs per day.", evidenceRule: "owner confirms",
});
const CALENDAR = {
  jurisdiction: "XX-CO",
  rules: [
    rule("annual-return", "Annual return", 1, 31, 1),
    rule("vat-t1", "VAT return, term 1", 4, 10, 0),
    rule("tax-return", "Tax return", 5, 31, 1),
    rule("vat-t2", "VAT return, term 2", 6, 10, 0),
    rule("meeting", "Annual meeting", 6, 30, 1),
    rule("accounts", "Annual accounts", 7, 31, 1),
    rule("vat-t3", "VAT return, term 3", 8, 31, 0),
    rule("vat-t4", "VAT return, term 4", 10, 10, 0),
  ],
};
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "deadline-calendar-"));
  writeFileSync(join(dir, "calendar.json"), JSON.stringify(CALENDAR));
  process.env["DEADLINE_CALENDAR_FILE"] = join(dir, "calendar.json");
});
afterAll(() => {
  delete process.env["DEADLINE_CALENDAR_FILE"];
  rmSync(dir, { recursive: true, force: true });
});

describe("the installation's calendar", () => {
  it("is absent unless DEADLINE_CALENDAR_FILE names a file, and minting then says so", () => {
    expect(statutoryCalendar({})).toBeNull();
    const saved = process.env["DEADLINE_CALENDAR_FILE"];
    delete process.env["DEADLINE_CALENDAR_FILE"];
    try {
      expect(jurisdictionFor(undefined)).toBeNull();
      expect(() => mintYear("XX-CO", 2026, { includePast: true })).toThrow(/no statutory calendar is configured/);
    } finally {
      process.env["DEADLINE_CALENDAR_FILE"] = saved;
    }
  });
  it("names the jurisdiction when the caller does not, and refuses a different one", () => {
    expect(jurisdictionFor(undefined)).toBe("XX-CO");
    expect(jurisdictionFor("YY-CO")).toBe("YY-CO");
    expect(() => mintYear("YY-CO", 2026, { includePast: true })).toThrow(/"XX-CO", not "YY-CO"/);
  });
  it("refuses a malformed calendar, naming the problem", () => {
    expect(() => parseStatutoryCalendar("{")).toThrow(/not valid JSON/);
    expect(() => parseStatutoryCalendar(JSON.stringify({ jurisdiction: "A", rules: [{ ...rule("k", "t", 13, 1, 0) }] }))).toThrow(/"month"/);
    expect(() => parseStatutoryCalendar(JSON.stringify({ jurisdiction: "A", rules: [rule("k", "t", 1, 1, 0), rule("k", "u", 2, 1, 0)] }))).toThrow(/duplicate key "k"/);
  });
  it("defaults the evidence rule to the owner confirming", () => {
    const { rules } = parseStatutoryCalendar(JSON.stringify({ jurisdiction: "A", rules: [{ ...rule("k", "t", 1, 1, 0), evidenceRule: undefined }] }));
    expect(rules[0]!.evidenceRule).toBe("owner confirms");
  });
});

describe("mintYear", () => {
  /** Before the fiscal year starts: every rule is still ahead, so nothing is skipped. */
  const AHEAD = { today: "2025-12-31" };

  it("mints every rule, offsets the year-after rules, keeps order by due date", () => {
    const { minted: rows, skippedPast } = mintYear("XX-CO", 2026, AHEAD);
    expect(rows).toHaveLength(8);
    expect(skippedPast).toEqual([]);
    expect(rows.find((r) => r.ruleKey === "vat-t3")?.dueDate).toBe("2026-08-31");
    expect(rows.find((r) => r.ruleKey === "accounts")?.dueDate).toBe("2027-07-31");
    expect(rows.find((r) => r.ruleKey === "annual-return")?.dueDate).toBe("2027-01-31");
    expect(rows.map((r) => r.dueDate)).toEqual([...rows.map((r) => r.dueDate)].sort());
    for (const r of rows) { expect(r.source).toBe("statutory"); expect(r.recurrence).toBe("yearly"); expect(r.consequence.length).toBeGreaterThan(10); }
  });
  it("omits named rules (a company that is not VAT-registered)", () => {
    const { minted: rows } = mintYear("XX-CO", 2026, { ...AHEAD, omit: CALENDAR.rules.filter((r) => r.key.startsWith("vat-")).map((r) => r.key) });
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.ruleKey.startsWith("vat-"))).toBe(false);
  });
  it("refuses an unknown rule key in omit — a typo must not silently keep a deadline", () => {
    expect(() => mintYear("XX-CO", 2026, { ...AHEAD, omit: ["vat-t9"] })).toThrow(/vat-t9/);
  });

  // ── The already-past skip review fix) ───────────────────────────────────────────
  //
  // A mid-year mint used to insert every term from January onwards, each one overdue on arrival —
  // and the brief names an overdue row EVERY day, so the next morning opened with a wall of
  // filings that were made months ago.
  describe("dates already behind the owner's day", () => {
    it("skips them by default and NAMES them, rather than minting fewer rows in silence", () => {
      const { minted, skippedPast } = mintYear("XX-CO", 2026, { today: "2026-09-08" });
      expect(minted.length + skippedPast.length).toBe(8);
      expect(skippedPast.length).toBeGreaterThan(0);
      for (const r of skippedPast) expect(r.dueDate < "2026-09-08").toBe(true);
      for (const r of minted) expect(r.dueDate < "2026-09-08").toBe(false);
      // The one that lands on the boundary belongs to the owner, not to history.
      expect(minted.some((r) => r.ruleKey === "vat-t4")).toBe(true);
    });

    it("a deadline falling ON the owner's day is still minted — today is not past", () => {
      const { minted, skippedPast } = mintYear("XX-CO", 2026, { today: "2026-08-31" });
      expect(minted.some((r) => r.dueDate === "2026-08-31")).toBe(true);
      expect(skippedPast.some((r) => r.dueDate === "2026-08-31")).toBe(false);
    });

    it("includePast: true mints the whole year and skips nothing — the deliberate backfill", () => {
      const { minted, skippedPast } = mintYear("XX-CO", 2026, { includePast: true });
      expect(minted).toHaveLength(8);
      expect(skippedPast).toEqual([]);
    });

    it("REFUSES to guess the owner's day: no `today` and no `includePast` throws", () => {
      // The engine has no clock (file header). A default of `new Date()` here would silently put
      // the boundary on the server's zone, which is the/128/204 mistake.
      expect(() => mintYear("XX-CO", 2026)).toThrow(/today/i);
      expect(() => mintYear("XX-CO", 2026, { omit: [] })).toThrow(/today/i);
      expect(() => mintYear("XX-CO", 2026, { today: "08.09.2026" })).toThrow(/today/i);
    });
  });
});

describe("daysToDue (owner clock)", () => {
  it("counts whole owner days, so 23:30 Oslo the night before is 1 day, not 0", () => {
    expect(daysToDue("2026-08-31", new Date("2026-08-30T21:30:00Z"), TZ)).toBe(1); // 23:30 Oslo
    expect(daysToDue("2026-08-31", new Date("2026-08-30T22:30:00Z"), TZ)).toBe(0); // 00:30 Oslo on the day
    expect(daysToDue("2026-08-31", new Date("2026-09-02T10:00:00Z"), TZ)).toBe(-2);
  });
});

describe("mentionsToday", () => {
  it("lists on the mention days and every overdue day, never on the days between", () => {
    const at = (dd: number) => new Date(Date.parse("2026-08-31T10:00:00Z") - dd * 86_400_000);
    for (const dd of MENTION_DAYS) expect(mentionsToday(open(), at(dd), TZ), `T-${dd}`).toBe(true);
    for (const dd of [29, 15, 7, 3]) expect(mentionsToday(open(), at(dd), TZ), `T-${dd}`).toBe(false);
    expect(mentionsToday(open(), at(-3), TZ)).toBe(true);
  });
  it("is silent once the ladder has stopped, and for closed rows", () => {
    expect(mentionsToday(open({ rung: 3 }), new Date("2026-09-03T10:00:00Z"), TZ)).toBe(false);
    expect(mentionsToday(open({ status: "done" }), new Date("2026-08-31T10:00:00Z"), TZ)).toBe(false);
  });
});

describe("ladderStep (Ruling 1)", () => {
  it("rung 1 at 15:00 owner clock on T-1, not before", () => {
    expect(ladderStep(open(), new Date("2026-08-30T12:59:00Z"), TZ)).toBeNull();               // 14:59 Oslo
    expect(ladderStep(open(), new Date("2026-08-30T13:00:00Z"), TZ)).toEqual({ rung: 1, finalStop: false });
  });
  it("rung 2 at 09:00 on the due day, statutory only", () => {
    expect(ladderStep(open({ rung: 1 }), new Date("2026-08-31T07:00:00Z"), TZ)).toEqual({ rung: 2, finalStop: false });
    expect(ladderStep(open({ rung: 1, source: "manual" }), new Date("2026-08-31T07:00:00Z"), TZ)).toBeNull();
  });
  // `"renewal"` widens `DeadlineSource` for domains, certificates and subscriptions
  // that carry a vendor and an amount — it is not statutory, so it steps the ladder exactly like
  // any other non-statutory source (no rung 2 on the due day).
  it("a renewal source steps the ladder like any other non-statutory source", () => {
    expect(ladderStep(open({ rung: 1, source: "renewal" }), new Date("2026-08-31T07:00:00Z"), TZ)).toBeNull();
    expect(ladderStep(open({ rung: 0, source: "renewal" }), new Date("2026-08-30T13:00:00Z"), TZ)).toEqual({ rung: 1, finalStop: false });
  });
  it("rung 3 is the final stop at 09:00 on T+1, for every source, and never repeats", () => {
    expect(ladderStep(open({ rung: 2 }), new Date("2026-09-01T07:00:00Z"), TZ)).toEqual({ rung: 3, finalStop: true });
    expect(ladderStep(open({ rung: 1, source: "manual" }), new Date("2026-09-01T07:00:00Z"), TZ)).toEqual({ rung: 3, finalStop: true });
    expect(ladderStep(open({ rung: 3 }), new Date("2026-09-05T07:00:00Z"), TZ)).toBeNull();
  });
  it("a rung missed on its day is not caught up: T+1 with rung 0 goes straight to the stop", () => {
    expect(ladderStep(open({ rung: 0 }), new Date("2026-09-01T07:00:00Z"), TZ)).toEqual({ rung: 3, finalStop: true });
  });
  it("closed rows never step", () => {
    expect(ladderStep(open({ status: "dismissed" }), new Date("2026-09-01T07:00:00Z"), TZ)).toBeNull();
  });
});

describe("nextDue", () => {
  it("yearly / bimonthly / monthly / none, day clamped", () => {
    expect(nextDue("2026-08-31", "yearly")).toBe("2027-08-31");
    expect(nextDue("2026-08-31", "bimonthly")).toBe("2026-10-31");
    expect(nextDue("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDue("2026-08-31", "none")).toBeNull();
  });
});
