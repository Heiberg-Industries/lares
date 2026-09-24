import { describe, it, expect } from "vitest";
import { STATUTORY_RULES, mintYear, daysToDue, mentionsToday, ladderStep, nextDue, MENTION_DAYS } from "../src/deadlines.js";
const TZ = "Europe/Oslo";
const open = (over: Partial<Parameters<typeof ladderStep>[0]> = {}) => ({ id: "d1", title: "MVA-melding, 3. termin", source: "statutory" as const, dueDate: "2026-08-31", rung: 0, status: "open" as const, ...over });

describe("mintYear", () => {
  /** Before the fiscal year starts: every rule is still ahead, so nothing is skipped. */
  const AHEAD = { today: "2025-12-31" };

  it("mints 12 rows for a Norwegian AS, offsets the year-after rules, keeps order by due date", () => {
    const { minted: rows, skippedPast } = mintYear("NO-AS", 2026, AHEAD);
    expect(rows).toHaveLength(12);
    expect(skippedPast).toEqual([]);
    expect(rows.find((r) => r.ruleKey === "mva-t3")?.dueDate).toBe("2026-08-31");
    expect(rows.find((r) => r.ruleKey === "aarsregnskap")?.dueDate).toBe("2027-07-31");
    expect(rows.find((r) => r.ruleKey === "mva-t6")?.dueDate).toBe("2027-02-10");
    expect(rows.map((r) => r.dueDate)).toEqual([...rows.map((r) => r.dueDate)].sort());
    for (const r of rows) { expect(r.source).toBe("statutory"); expect(r.recurrence).toBe("yearly"); expect(r.consequence.length).toBeGreaterThan(10); }
  });
  it("omits named rules (a company that is not VAT-registered)", () => {
    const { minted: rows } = mintYear("NO-AS", 2026, { ...AHEAD, omit: STATUTORY_RULES["NO-AS"].filter((r) => r.key.startsWith("mva-")).map((r) => r.key) });
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.ruleKey.startsWith("mva-"))).toBe(false);
  });
  it("refuses an unknown rule key in omit — a typo must not silently keep a deadline", () => {
    expect(() => mintYear("NO-AS", 2026, { ...AHEAD, omit: ["mva-t9"] })).toThrow(/mva-t9/);
  });

  // ── The already-past skip (ORB-180 review fix) ───────────────────────────────────────────
  //
  // A mid-year mint used to insert every term from January onwards, each one overdue on arrival —
  // and the brief names an overdue row EVERY day, so the next morning opened with a wall of
  // filings that were made months ago.
  describe("dates already behind the owner's day", () => {
    it("skips them by default and NAMES them, rather than minting fewer rows in silence", () => {
      const { minted, skippedPast } = mintYear("NO-AS", 2026, { today: "2026-09-08" });
      expect(minted.length + skippedPast.length).toBe(12);
      expect(skippedPast.length).toBeGreaterThan(0);
      for (const r of skippedPast) expect(r.dueDate < "2026-09-08").toBe(true);
      for (const r of minted) expect(r.dueDate < "2026-09-08").toBe(false);
      // The one that lands on the boundary belongs to the owner, not to history.
      expect(minted.some((r) => r.ruleKey === "mva-t4")).toBe(true);
    });

    it("a deadline falling ON the owner's day is still minted — today is not past", () => {
      const { minted, skippedPast } = mintYear("NO-AS", 2026, { today: "2026-08-31" });
      expect(minted.some((r) => r.dueDate === "2026-08-31")).toBe(true);
      expect(skippedPast.some((r) => r.dueDate === "2026-08-31")).toBe(false);
    });

    it("includePast: true mints the whole year and skips nothing — the deliberate backfill", () => {
      const { minted, skippedPast } = mintYear("NO-AS", 2026, { includePast: true });
      expect(minted).toHaveLength(12);
      expect(skippedPast).toEqual([]);
    });

    it("REFUSES to guess the owner's day: no `today` and no `includePast` throws", () => {
      // The engine has no clock (file header). A default of `new Date()` here would silently put
      // the boundary on the server's zone, which is the ORB-124/128/204 mistake.
      expect(() => mintYear("NO-AS", 2026)).toThrow(/today/i);
      expect(() => mintYear("NO-AS", 2026, { omit: [] })).toThrow(/today/i);
      expect(() => mintYear("NO-AS", 2026, { today: "08.09.2026" })).toThrow(/today/i);
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
  // LAR-22-s1: `"renewal"` widens `DeadlineSource` for domains, certificates and subscriptions
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
