import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/db", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("../lib/auth", () => ({ verify: vi.fn(async () => "owner@owner.example") }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { pool } from "../lib/db";
import {
  saveLadderEnabled, addDeadline, mintStatutoryYear, markDone, dismiss, resetRung,
  ignoreCandidate, addFromCandidate,
} from "../app/actions/deadlines";

const mockedQuery = vi.mocked(pool.query);
const mockedConnect = vi.mocked(pool.connect);
const queries: Array<{ sql: string; params: unknown[] }> = [];

/** Set before a `markDone` call to control what the closing UPDATE ... RETURNING reports. */
let doneRow: {
  entity: string; title: string; source: string; due_date: string;
  recurrence: string; consequence: string | null; evidence_rule: string; rule_key: string | null;
  vendor?: string | null; amount?: string | null; currency?: string | null;
} | null = null;

/** Rule keys the "already present" check should report as existing, for `mintStatutoryYear` tests. */
let existingRuleKeys: string[] = [];

/** Set to throw from the next `INSERT INTO deadlines` a transaction issues, to exercise the
 *  ROLLBACK path of `markDone`'s recurrence insert. */
let insertShouldThrow: Error | null = null;

/** Shared by both `pool.query` (every action but `markDone`) and the client `pool.connect()`
 *  returns (`markDone`'s transaction) — one router so a test asserting the full query sequence
 *  sees every statement, transaction control included, in the order it actually ran. */
async function routeQuery(sql: unknown, params: unknown = []): Promise<{ rows: unknown[]; rowCount: number }> {
  const s = String(sql);
  queries.push({ sql: s, params: params as unknown[] });

  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(s)) return { rows: [], rowCount: 0 };
  if (/SELECT 1 FROM deadlines WHERE/i.test(s)) {
    const ruleKey = (params as unknown[])[2] as string;
    return { rows: existingRuleKeys.includes(ruleKey) ? [{ "?column?": 1 }] : [], rowCount: 0 };
  }
  if (/UPDATE deadlines SET status = 'done'/i.test(s)) {
    return doneRow === null ? { rows: [], rowCount: 0 } : { rows: [doneRow], rowCount: 1 };
  }
  if (/INSERT INTO deadlines/i.test(s) && insertShouldThrow !== null) {
    const err = insertShouldThrow;
    throw err;
  }
  if (/UPDATE deadlines SET status = 'dismissed'/i.test(s)) {
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE deadlines SET rung = 0/i.test(s)) {
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE deadline_candidates/i.test(s)) {
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
}

beforeEach(() => {
  queries.length = 0;
  doneRow = null;
  existingRuleKeys = [];
  insertShouldThrow = null;
  mockedQuery.mockReset();
  mockedQuery.mockImplementation((sql: unknown, params: unknown = []) => routeQuery(sql, params));
  mockedConnect.mockReset();
  mockedConnect.mockImplementation(async () => ({
    query: vi.fn((sql: unknown, params: unknown = []) => routeQuery(sql, params)),
    release: vi.fn(),
  }) as never);
});

const inserts = (table: string) => queries.filter((q) => new RegExp(`INSERT INTO ${table}`, "i").test(q.sql));

describe("saveLadderEnabled", () => {
  it("upserts ladder_enabled and revalidates /deadlines", async () => {
    expect(await saveLadderEnabled({ enabled: true })).toEqual({ ok: true });
    const w = inserts("deadline_settings")[0]!;
    expect(w.sql).toMatch(/ON CONFLICT \(owner\)/i);
    expect(w.sql).toMatch(/DO UPDATE SET ladder_enabled = EXCLUDED\.ladder_enabled/i);
    expect(w.params).toEqual(["bendik", true, "owner@owner.example"]);
  });
  it("refuses a non-boolean without writing", async () => {
    // @ts-expect-error deliberately wrong shape
    const r = await saveLadderEnabled({ enabled: "yes" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/on or off/i) });
    expect(inserts("deadline_settings")).toHaveLength(0);
  });
});

describe("addDeadline", () => {
  it("inserts a well-formed deadline", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "Renew lease", dueDate: "2099-01-01", source: "contract" });
    expect(r).toEqual({ ok: true });
    const w = inserts("deadlines")[0]!;
    expect(w.params).toEqual(["bendik", "Heiberg AS", "Renew lease", "contract", "2099-01-01", "none", null, "owner@owner.example", null, null, null]);
  });

  // ── vendor / amount / currency (LAR-22-s4) ─────────────────────────────────────────────────
  it("a renewal add stores vendor, amount and currency, upper-casing a lower-case currency", async () => {
    const r = await addDeadline({
      entity: "Heiberg AS", title: "Domain renewal", dueDate: "2099-03-03", source: "renewal",
      vendor: "Domeneshop", amount: 199, currency: "nok",
    });
    expect(r).toEqual({ ok: true });
    const w = inserts("deadlines")[0]!;
    expect(w.params).toEqual(["bendik", "Heiberg AS", "Domain renewal", "renewal", "2099-03-03", "none", null, "owner@owner.example", "Domeneshop", 199, "NOK"]);
  });

  it("refuses a non-positive amount, writing nothing", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "x", dueDate: "2099-01-01", source: "renewal", amount: 0 });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/positive/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });

  it("refuses a negative amount, writing nothing", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "x", dueDate: "2099-01-01", source: "renewal", amount: -5 });
    expect(r.ok).toBe(false);
    expect(inserts("deadlines")).toHaveLength(0);
  });

  it("refuses a malformed currency, writing nothing", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "x", dueDate: "2099-01-01", source: "renewal", currency: "NOKR" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/three letters/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });

  it("vendor/amount/currency are accepted on a non-renewal source too", async () => {
    const r = await addDeadline({
      entity: "Heiberg AS", title: "Subscription", dueDate: "2099-01-01", source: "subscription",
      vendor: "Vendor Co", amount: 10, currency: "USD",
    });
    expect(r).toEqual({ ok: true });
    const w = inserts("deadlines")[0]!;
    expect(w.params).toEqual(["bendik", "Heiberg AS", "Subscription", "subscription", "2099-01-01", "none", null, "owner@owner.example", "Vendor Co", 10, "USD"]);
  });
  it("refuses an empty entity", async () => {
    const r = await addDeadline({ entity: "  ", title: "x", dueDate: "2099-01-01", source: "manual" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/entity/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("refuses an empty title", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "", dueDate: "2099-01-01", source: "manual" });
    expect(r.ok).toBe(false);
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("refuses a malformed date", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "x", dueDate: "not-a-date", source: "manual" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/not a date/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("refuses a date in the past", async () => {
    const r = await addDeadline({ entity: "Heiberg AS", title: "x", dueDate: "2020-01-01", source: "manual" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/past/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("refuses an unknown source", async () => {
    // @ts-expect-error deliberately wrong value
    const r = await addDeadline({ entity: "Heiberg AS", title: "x", dueDate: "2099-01-01", source: "bogus" });
    expect(r.ok).toBe(false);
    expect(inserts("deadlines")).toHaveLength(0);
  });
});

describe("mintStatutoryYear", () => {
  // A fiscal year wholly in the future, so no rule is "already past" on any day this suite runs.
  const YEAR = 2099;

  it("inserts all twelve rules for a fresh entity", async () => {
    const r = await mintStatutoryYear({ entity: "Heiberg AS", fiscalYear: YEAR });
    expect(r).toEqual({ ok: true, inserted: 12, skipped: 0, skippedPast: [] });
    expect(inserts("deadlines")).toHaveLength(12);
    const one = inserts("deadlines").find((q) => q.params[6] === "aksjonaerregister")!;
    expect(one.params).toEqual(["bendik", "Heiberg AS", "Aksjonærregisteroppgaven", "2100-01-31", "yearly", "Tvangsmulkt fra Skatteetaten løper per dag", "aksjonaerregister", "owner@owner.example"]);
    expect(one.sql).toMatch(/source = 'statutory'|'statutory'/i);
  });
  it("skips rows already present for (owner, entity, rule_key, due_date)", async () => {
    existingRuleKeys = ["aksjonaerregister", "mva-t1"];
    const r = await mintStatutoryYear({ entity: "Heiberg AS", fiscalYear: YEAR });
    expect(r).toEqual({ ok: true, inserted: 10, skipped: 2, skippedPast: [] });
  });
  it("respects the omit list, dropping rules before insert/skip accounting", async () => {
    const r = await mintStatutoryYear({ entity: "Heiberg AS", fiscalYear: YEAR, omit: ["mva-t1", "mva-t2"] });
    expect(r).toEqual({ ok: true, inserted: 10, skipped: 0, skippedPast: [] });
  });

  // ── Already-past dates (review fix, ORB-180) ───────────────────────────────────────────────
  //
  // The same rule Saga's `deadline_mint_statutory` now applies: a mint of a year already gone
  // would insert twelve rows overdue on arrival, and the brief names an overdue row every morning.
  it("a year already gone inserts NOTHING and names every rule it skipped", async () => {
    const r = await mintStatutoryYear({ entity: "Heiberg AS", fiscalYear: 2000 });
    expect(r).toEqual({ ok: true, inserted: 0, skipped: 0, skippedPast: expect.any(Array) });
    if (!r.ok) throw new Error("unreachable");
    expect(r.skippedPast).toHaveLength(12);
    expect(r.skippedPast).toContain("Aksjonærregisteroppgaven");
    expect(inserts("deadlines")).toHaveLength(0);
  });

  it("refuses an unknown omit key without writing", async () => {
    const r = await mintStatutoryYear({ entity: "Heiberg AS", fiscalYear: YEAR, omit: ["not-a-rule"] });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/unknown rule key/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("refuses an empty entity", async () => {
    const r = await mintStatutoryYear({ entity: "  ", fiscalYear: 2026 });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/entity/i) });
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("refuses a fractional fiscal year", async () => {
    const r = await mintStatutoryYear({ entity: "Heiberg AS", fiscalYear: 2026.5 });
    expect(r.ok).toBe(false);
    expect(inserts("deadlines")).toHaveLength(0);
  });
});

describe("markDone", () => {
  it("refuses empty evidence without writing", async () => {
    const r = await markDone({ id: "d1", evidence: "  " });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/evidence/i) });
    expect(queries.filter((q) => /UPDATE deadlines SET status = 'done'/i.test(q.sql))).toHaveLength(0);
  });
  it("closes a non-recurring row and mints nothing", async () => {
    doneRow = {
      entity: "Heiberg AS", title: "One-off filing", source: "manual",
      due_date: "2026-09-01", recurrence: "none", consequence: null, evidence_rule: "owner confirms", rule_key: null,
      vendor: null, amount: null, currency: null,
    };
    const r = await markDone({ id: "d1", evidence: "Filed via Altinn receipt #123" });
    expect(r).toEqual({ ok: true });
    const upd = queries.find((q) => /UPDATE deadlines SET status = 'done'/i.test(q.sql))!;
    expect(upd.params).toEqual(["d1", "bendik", "Filed via Altinn receipt #123"]);
    expect(inserts("deadlines")).toHaveLength(0);
  });
  it("closes a recurring row and mints the successor with rung 0 and created_by 'recurrence'", async () => {
    doneRow = {
      entity: "Heiberg AS", title: "MVA-melding, 1. termin", source: "statutory",
      due_date: "2026-04-10", recurrence: "yearly", consequence: "Tvangsmulkt", evidence_rule: "owner confirms", rule_key: "mva-t1",
      vendor: null, amount: null, currency: null,
    };
    const r = await markDone({ id: "d1", evidence: "Filed" });
    expect(r).toEqual({ ok: true });
    const mint = inserts("deadlines")[0]!;
    expect(mint.sql).toMatch(/'recurrence'/i);
    expect(mint.sql).toMatch(/rung/i);
    expect(mint.params).toEqual(["bendik", "Heiberg AS", "MVA-melding, 1. termin", "statutory", "2027-04-10", "yearly", "Tvangsmulkt", "owner confirms", "mva-t1", null, null, null]);
  });

  // LAR-22-s4 — a recurring RENEWAL's successor carries vendor, amount and currency forward. The
  // RETURNING row's `amount` is the raw pg shape (a string, "199.00"), passed straight through to
  // the successor's INSERT params — this action never converts it to a number, unlike the DTO
  // mapper `readOpenDeadlines`/`readClosedDeadlines` use for display.
  it("closes a recurring renewal and mints a successor carrying vendor, amount and currency", async () => {
    doneRow = {
      entity: "Heiberg AS", title: "Domain renewal", source: "renewal",
      due_date: "2026-03-03", recurrence: "yearly", consequence: null, evidence_rule: "owner confirms", rule_key: null,
      vendor: "Domeneshop", amount: "199.00", currency: "NOK",
    };
    const r = await markDone({ id: "d1", evidence: "Renewed" });
    expect(r).toEqual({ ok: true });
    const mint = inserts("deadlines")[0]!;
    expect(mint.params).toEqual(["bendik", "Heiberg AS", "Domain renewal", "renewal", "2027-03-03", "yearly", null, "owner confirms", null, "Domeneshop", "199.00", "NOK"]);
  });

  it("clamps a monthly successor's day to the target month's length", async () => {
    doneRow = {
      entity: "Heiberg AS", title: "Monthly filing", source: "manual",
      due_date: "2026-01-31", recurrence: "monthly", consequence: null, evidence_rule: "owner confirms", rule_key: null,
      vendor: null, amount: null, currency: null,
    };
    await markDone({ id: "d1", evidence: "done" });
    const mint = inserts("deadlines")[0]!;
    expect(mint.params[4]).toBe("2026-02-28");
  });
  it("refuses when the row is not open (already closed)", async () => {
    doneRow = null; // the UPDATE ... WHERE status = 'open' guard returns no rows
    const r = await markDone({ id: "d1", evidence: "x" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/not open/i) });
  });

  it("runs BEGIN -> UPDATE -> INSERT -> COMMIT, in that order, for a recurring row", async () => {
    doneRow = {
      entity: "Heiberg AS", title: "MVA-melding, 1. termin", source: "statutory",
      due_date: "2026-04-10", recurrence: "yearly", consequence: "Tvangsmulkt", evidence_rule: "owner confirms", rule_key: "mva-t1",
    };
    await markDone({ id: "d1", evidence: "Filed" });
    const seq = queries.map((q) => q.sql.trim());
    const beginIdx = seq.findIndex((s) => /^BEGIN$/i.test(s));
    const updateIdx = seq.findIndex((s) => /^UPDATE deadlines SET status = 'done'/i.test(s));
    const insertIdx = seq.findIndex((s) => /^INSERT INTO deadlines/i.test(s));
    const commitIdx = seq.findIndex((s) => /^COMMIT$/i.test(s));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(beginIdx);
    expect(insertIdx).toBeGreaterThan(updateIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
    expect(seq.some((s) => /^ROLLBACK$/i.test(s))).toBe(false);
  });

  it("rolls back and rethrows when the successor insert fails — a recurring deadline must not close with its successor silently lost", async () => {
    doneRow = {
      entity: "Heiberg AS", title: "MVA-melding, 1. termin", source: "statutory",
      due_date: "2026-04-10", recurrence: "yearly", consequence: "Tvangsmulkt", evidence_rule: "owner confirms", rule_key: "mva-t1",
    };
    insertShouldThrow = new Error("connection reset");
    await expect(markDone({ id: "d1", evidence: "Filed" })).rejects.toThrow("connection reset");
    const seq = queries.map((q) => q.sql.trim());
    expect(seq.some((s) => /^ROLLBACK$/i.test(s))).toBe(true);
    expect(seq.some((s) => /^COMMIT$/i.test(s))).toBe(false);
  });
});

describe("dismiss", () => {
  it("refuses empty reason without writing", async () => {
    const r = await dismiss({ id: "d1", reason: " " });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/reason/i) });
  });
  it("closes the row as dismissed with the given reason", async () => {
    const r = await dismiss({ id: "d1", reason: "No longer applies" });
    expect(r).toEqual({ ok: true });
    const upd = queries.find((q) => /UPDATE deadlines SET status = 'dismissed'/i.test(q.sql))!;
    expect(upd.params).toEqual(["d1", "bendik", "No longer applies"]);
  });
});

describe("resetRung", () => {
  it("resets the rung to 0", async () => {
    const r = await resetRung({ id: "d1" });
    expect(r).toEqual({ ok: true });
    const upd = queries.find((q) => /UPDATE deadlines SET rung = 0/i.test(q.sql))!;
    expect(upd.params).toEqual(["d1", "bendik"]);
  });
});

describe("ignoreCandidate", () => {
  it("marks a candidate ignored", async () => {
    const r = await ignoreCandidate({ threadId: "t1", resolution: "ignored" });
    expect(r).toEqual({ ok: true });
    const upd = queries.find((q) => /UPDATE deadline_candidates/i.test(q.sql))!;
    expect(upd.sql).toMatch(/resolution = 'ignored'/i);
    expect(upd.params).toEqual(["bendik", "t1"]);
  });
  it("refuses resolution: 'added' with zero writes — this bare action can only ignore; adding goes through addFromCandidate", async () => {
    // @ts-expect-error deliberately the one value this action must refuse
    const r = await ignoreCandidate({ threadId: "t1", resolution: "added" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/can only ignore/i) });
    expect(queries.filter((q) => /UPDATE deadline_candidates/i.test(q.sql))).toHaveLength(0);
  });
  it("refuses an unknown resolution with zero writes", async () => {
    // @ts-expect-error deliberately wrong value
    const r = await ignoreCandidate({ threadId: "t1", resolution: "bogus" });
    expect(r.ok).toBe(false);
    expect(queries.filter((q) => /UPDATE deadline_candidates/i.test(q.sql))).toHaveLength(0);
  });
});

describe("addFromCandidate", () => {
  it("inserts the deadline AND marks the candidate added, in one action", async () => {
    const r = await addFromCandidate({ threadId: "t1", entity: "Heiberg AS", title: "Contract renewal", dueDate: "2099-01-01" });
    expect(r).toEqual({ ok: true });
    expect(inserts("deadlines")).toHaveLength(1);
    const candidateWrite = queries.find((q) => /UPDATE deadline_candidates/i.test(q.sql))!;
    expect(candidateWrite.params).toEqual(["bendik", "t1"]);
    expect(candidateWrite.sql).toMatch(/resolution = 'added'/i);
  });
  it("refuses an empty title without writing either row", async () => {
    const r = await addFromCandidate({ threadId: "t1", entity: "Heiberg AS", title: "", dueDate: "2099-01-01" });
    expect(r.ok).toBe(false);
    expect(inserts("deadlines")).toHaveLength(0);
    expect(queries.filter((q) => /UPDATE deadline_candidates/i.test(q.sql))).toHaveLength(0);
  });
});

describe("authentication", () => {
  it("throws before any write when there is no session", async () => {
    const auth = await import("../lib/auth");
    vi.mocked(auth.verify).mockResolvedValueOnce(null);
    await expect(saveLadderEnabled({ enabled: true })).rejects.toThrow(/unauthenticated/);
    expect(queries).toHaveLength(0);
  });
});
