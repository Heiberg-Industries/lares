import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/db", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../lib/db";
import {
  STATUTORY_RULES_MIRROR,
  MENTION_DAYS_MIRROR,
  DEADLINE_SOURCES,
  standingDateLabel,
  mintYearFromMirror,
  daysUntil,
  dueColor,
  nextDueDate,
  isValidIsoDate,
  readOpenDeadlines,
} from "../lib/deadlines";

describe("STATUTORY_RULES_MIRROR", () => {
  it("has twelve rules, one per Norwegian AS statutory line item", () => {
    expect(STATUTORY_RULES_MIRROR).toHaveLength(12);
    expect(new Set(STATUTORY_RULES_MIRROR.map((r) => r.key)).size).toBe(12);
  });
});

describe("DEADLINE_SOURCES", () => {
  it("includes 'renewal' (LAR-22)", () => {
    expect(DEADLINE_SOURCES).toContain("renewal");
  });
});

// LAR-22-s4 — `amount` is `numeric(12,2)`, which node-postgres never parses to a float; it comes
// back on `rows` as a STRING. `mapDeadlineRow` (private) converts it deliberately — this is the
// one place that conversion is observable from outside the module, through the read it feeds.
describe("readOpenDeadlines — amount round-trips as a number", () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
  });

  it("converts pg's string numeric to a JS number, and passes vendor/currency through", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{
        id: "d1", entity: "Heiberg AS", title: "Domain renewal", source: "renewal",
        due_date: "2027-03-03", recurrence: "yearly", consequence: null, evidence_rule: "owner confirms",
        status: "open", status_reason: null, resolved_at: null, rung: 0, rule_key: null, created_by: "owner@owner.example",
        vendor: "Domeneshop", amount: "199.00", currency: "NOK",
      }],
      rowCount: 1,
    } as never);
    const [row] = await readOpenDeadlines("bendik");
    expect(row?.amount).toBe(199);
    expect(typeof row?.amount).toBe("number");
    expect(row?.vendor).toBe("Domeneshop");
    expect(row?.currency).toBe("NOK");
  });

  it("a null amount stays null, not 0 or NaN", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{
        id: "d1", entity: "Heiberg AS", title: "One-off", source: "manual",
        due_date: "2027-03-03", recurrence: "none", consequence: null, evidence_rule: "owner confirms",
        status: "open", status_reason: null, resolved_at: null, rung: 0, rule_key: null, created_by: "owner@owner.example",
        vendor: null, amount: null, currency: null,
      }],
      rowCount: 1,
    } as never);
    const [row] = await readOpenDeadlines("bendik");
    expect(row?.amount).toBeNull();
  });
});

describe("MENTION_DAYS_MIRROR", () => {
  it("matches the kit's named list", () => {
    expect(MENTION_DAYS_MIRROR).toEqual([30, 16, 8, 4, 2, 1, 0]);
  });
});

describe("standingDateLabel", () => {
  it("renders a month/day pair in plain English, independent of any year", () => {
    expect(standingDateLabel(1, 31)).toBe("31 January");
    expect(standingDateLabel(12, 10)).toBe("10 December");
  });
});

describe("mintYearFromMirror", () => {
  /** Before the fiscal year starts, so nothing is "already past" in the shape tests below. */
  const AHEAD = { today: "2025-12-31" };

  it("computes every rule's due date for a fiscal year, applying yearOffset", () => {
    const { minted: rows, skippedPast } = mintYearFromMirror(2026, [], AHEAD);
    expect(rows).toHaveLength(12);
    expect(skippedPast).toEqual([]);
    const aksjonaerregister = rows.find((r) => r.ruleKey === "aksjonaerregister");
    // yearOffset 1, month 1, day 31 -> fiscal year + 1
    expect(aksjonaerregister?.dueDate).toBe("2027-01-31");
    const mvaT1 = rows.find((r) => r.ruleKey === "mva-t1");
    // yearOffset 0, month 4, day 10 -> fiscal year itself
    expect(mvaT1?.dueDate).toBe("2026-04-10");
  });

  it("sorts the rows by due date ascending", () => {
    const dates = mintYearFromMirror(2026, [], AHEAD).minted.map((r) => r.dueDate);
    expect(dates).toEqual([...dates].sort());
  });

  it("drops rules named in omit", () => {
    const { minted: rows } = mintYearFromMirror(2026, ["mva-t1", "mva-t2"], AHEAD);
    expect(rows).toHaveLength(10);
    expect(rows.some((r) => r.ruleKey === "mva-t1")).toBe(false);
  });

  it("throws on an unknown omit key — a silently-ignored typo is the wrong failure mode", () => {
    expect(() => mintYearFromMirror(2026, ["not-a-real-rule"], AHEAD)).toThrow(/unknown rule key/i);
  });

  // ── The already-past skip (review fix, ORB-180) — the kit's `mintYear` semantics, mirrored ──
  it("skips the terms already behind the owner's day and names them", () => {
    const { minted, skippedPast } = mintYearFromMirror(2026, [], { today: "2026-09-08" });
    expect(minted.length + skippedPast.length).toBe(12);
    expect(skippedPast.map((r) => r.ruleKey)).toEqual(["mva-t1", "mva-t2", "mva-t3"]);
    for (const r of minted) expect(r.dueDate < "2026-09-08").toBe(false);
  });

  it("a term falling ON the owner's day is still minted", () => {
    const { minted } = mintYearFromMirror(2026, [], { today: "2026-08-31" });
    expect(minted.some((r) => r.dueDate === "2026-08-31")).toBe(true);
  });

  it("includePast: true mints the whole year — the deliberate backfill", () => {
    const { minted, skippedPast } = mintYearFromMirror(2026, [], { includePast: true });
    expect(minted).toHaveLength(12);
    expect(skippedPast).toEqual([]);
  });

  it("refuses to guess the owner's day: no today and no includePast throws", () => {
    expect(() => mintYearFromMirror(2026, [], { today: "08.09.2026" })).toThrow(/today/i);
  });
});

describe("daysUntil", () => {
  it("is zero for a deadline due today on the owner's clock", () => {
    expect(daysUntil("2026-09-08", new Date("2026-09-08T12:00:00Z"), "Europe/Oslo")).toBe(0);
  });
  it("is positive for a future date and negative for a past one", () => {
    expect(daysUntil("2026-09-10", new Date("2026-09-08T12:00:00Z"), "Europe/Oslo")).toBe(2);
    expect(daysUntil("2026-09-01", new Date("2026-09-08T12:00:00Z"), "Europe/Oslo")).toBe(-7);
  });
  it("uses the OWNER's day, not the server's — 01:30 UTC on the 9th is still the 8th in New York", () => {
    expect(daysUntil("2026-09-08", new Date("2026-09-09T01:30:00Z"), "America/New_York")).toBe(0);
    expect(daysUntil("2026-09-08", new Date("2026-09-09T01:30:00Z"), "Europe/Oslo")).toBe(-1);
  });
});

describe("dueColor", () => {
  it("is bad when overdue", () => {
    expect(dueColor(-1)).toBe("bad");
    expect(dueColor(-30)).toBe("bad");
  });
  it("is warn at 0, 1 or 2 days out", () => {
    expect(dueColor(0)).toBe("warn");
    expect(dueColor(1)).toBe("warn");
    expect(dueColor(2)).toBe("warn");
  });
  it("is uncoloured further out", () => {
    expect(dueColor(3)).toBeNull();
    expect(dueColor(30)).toBeNull();
  });
});

describe("nextDueDate", () => {
  it("returns null for recurrence 'none'", () => {
    expect(nextDueDate("2026-09-08", "none")).toBeNull();
  });
  it("adds a year for 'yearly'", () => {
    expect(nextDueDate("2026-09-08", "yearly")).toBe("2027-09-08");
  });
  it("adds two months for 'bimonthly'", () => {
    expect(nextDueDate("2026-09-08", "bimonthly")).toBe("2026-11-08");
  });
  it("adds one month for 'monthly'", () => {
    expect(nextDueDate("2026-09-08", "monthly")).toBe("2026-10-08");
  });
  it("clamps the day to the target month's length rather than rolling over", () => {
    // 31 Jan + 1 month -> Feb has 28 days in 2026 (not a leap year)
    expect(nextDueDate("2026-01-31", "monthly")).toBe("2026-02-28");
  });
  it("rolls the year over at December", () => {
    expect(nextDueDate("2026-12-10", "bimonthly")).toBe("2027-02-10");
  });
});

describe("isValidIsoDate", () => {
  it("accepts a well-formed calendar date", () => {
    expect(isValidIsoDate("2026-09-08")).toBe(true);
  });
  it("refuses a malformed string", () => {
    expect(isValidIsoDate("2026/09/08")).toBe(false);
    expect(isValidIsoDate("08-09-2026")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });
  it("refuses a date that does not exist on the calendar", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
  });
});
