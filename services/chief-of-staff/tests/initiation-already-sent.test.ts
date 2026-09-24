import { describe, it, expect, vi } from "vitest";

import { alreadySentToday, SAGA_AGENT } from "../lib/initiation.js";

/**
 * LAR-17-s2 — `alreadySentToday`'s own contract, in isolation from a schedule: a single-slot
 * schedule's extra "at most one per owner-day" guard, now that a schedule's hour is a setting that
 * can change mid-day (see `lib/initiation.ts`'s own doc-comment for why the ledger's item-key
 * dedupe alone cannot catch this).
 */
describe("alreadySentToday", () => {
  const dbWithRows = (rows: unknown[]) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
    return { query } as never;
  };

  it("true when a sent row exists for ANY hour of the schedule on that owner-day", async () => {
    const db = dbWithRows([{ "?column?": 1 }]);
    expect(await alreadySentToday(db, "bendik", SAGA_AGENT, "morning-brief", "2026-09-18")).toBe(true);
  });

  it("false when no row matches", async () => {
    const db = dbWithRows([]);
    expect(await alreadySentToday(db, "bendik", SAGA_AGENT, "morning-brief", "2026-09-18")).toBe(false);
  });

  it("asks with the item-key prefix, the owner-day and status='sent' — not the exact slot key", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const db = { query } as never;
    await alreadySentToday(db, "bendik", SAGA_AGENT, "morning-brief", "2026-09-18");
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain("item_key LIKE");
    expect(String(sql)).toContain("status = 'sent'");
    expect(params).toEqual(["bendik", SAGA_AGENT, "2026-09-18", "morning-brief/%"]);
  });

  it("a query failure answers false, with one warning — never blocks the tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = { query: async () => { throw new Error("connection refused"); } } as never;
    expect(await alreadySentToday(db, "bendik", SAGA_AGENT, "evening-brief", "2026-09-18")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/evening-brief/);
    warn.mockRestore();
  });

  it("does not match a DIFFERENT schedule's sent row (the prefix is schedule-specific)", async () => {
    // A fake that only "sees" rows whose item_key actually starts with the LIKE prefix asked —
    // proving the prefix is schedule-scoped rather than a blanket "anything sent today".
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      const prefix = String(params[3]).replace(/%$/, "");
      const sentKeys = ["evening-brief/2026-09-18T20"];
      return { rows: sentKeys.some((k) => k.startsWith(prefix)) ? [{ x: 1 }] : [], rowCount: 0 };
    });
    const db = { query } as never;
    expect(await alreadySentToday(db, "bendik", SAGA_AGENT, "morning-brief", "2026-09-18")).toBe(false);
    expect(await alreadySentToday(db, "bendik", SAGA_AGENT, "evening-brief", "2026-09-18")).toBe(true);
  });
});
