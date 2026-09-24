import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/db", () => ({ pool: { query: vi.fn() } }));
vi.mock("../lib/auth", () => ({ verify: vi.fn(async () => "owner@owner.example") }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { pool } from "../lib/db";
import { saveRefreshEnabled, saveWatchlistMax } from "../app/actions/markets";

const mockedQuery = vi.mocked(pool.query);
const queries: Array<{ sql: string; params: unknown[] }> = [];

beforeEach(() => {
  queries.length = 0;
  mockedQuery.mockReset();
  mockedQuery.mockImplementation(async (sql: unknown, params: unknown = []) => {
    queries.push({ sql: String(sql), params: params as unknown[] });
    return { rows: [], rowCount: 1 };
  });
});

const writes = () => queries.filter((q) => /INSERT INTO markets_settings/i.test(q.sql));

describe("saveRefreshEnabled", () => {
  it("upserts refresh_enabled and touches only that column", async () => {
    expect(await saveRefreshEnabled({ enabled: true })).toEqual({ ok: true });
    const w = writes()[0]!;
    expect(w.sql).toMatch(/ON CONFLICT \(owner\)/i);
    expect(w.sql).toMatch(/DO UPDATE SET refresh_enabled = EXCLUDED\.refresh_enabled/i);
    expect(w.sql).not.toMatch(/watchlist_max = EXCLUDED/i);
    expect(w.params).toEqual(["bendik", true, "owner@owner.example"]);
  });
  it("refuses a non-boolean without writing", async () => {
    // @ts-expect-error deliberately wrong shape
    const r = await saveRefreshEnabled({ enabled: "yes" });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/on or off/i) });
    expect(writes()).toHaveLength(0);
  });
  it("reads the owner from AGENT_OWNER_USER_ID when set", async () => {
    process.env.AGENT_OWNER_USER_ID = " ada ";
    try {
      await saveRefreshEnabled({ enabled: false });
      expect(writes()[0]!.params[0]).toBe("ada");
    } finally {
      process.env.AGENT_OWNER_USER_ID = "bendik"; // restore explicit fixture identity
    }
  });
});

describe("saveWatchlistMax", () => {
  it("upserts a value within range and touches only that column", async () => {
    const r = await saveWatchlistMax({ value: 120 });
    expect(r).toEqual({ ok: true });
    const w = writes()[0]!;
    expect(w.sql).toMatch(/DO UPDATE SET watchlist_max = EXCLUDED\.watchlist_max/i);
    expect(w.sql).not.toMatch(/refresh_enabled = EXCLUDED/i);
    expect(w.params).toEqual(["bendik", 120, "owner@owner.example"]);
  });
  it("accepts the engine max itself (150)", async () => {
    expect((await saveWatchlistMax({ value: 150 })).ok).toBe(true);
  });
  it("accepts the schema floor itself (10)", async () => {
    expect((await saveWatchlistMax({ value: 10 })).ok).toBe(true);
  });
  it("refuses a value above the engine maximum and names it, without writing", async () => {
    const r = await saveWatchlistMax({ value: 500 });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/engine maximum of 150/i) });
    expect(writes()).toHaveLength(0);
  });
  it("refuses a value below 10 without writing", async () => {
    const r = await saveWatchlistMax({ value: 5 });
    expect(r.ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });
  it("refuses a fractional value without writing", async () => {
    const r = await saveWatchlistMax({ value: 99.5 });
    expect(r.ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});

describe("authentication", () => {
  it("throws before any write when there is no session", async () => {
    const auth = await import("../lib/auth");
    vi.mocked(auth.verify).mockResolvedValueOnce(null);
    await expect(saveRefreshEnabled({ enabled: true })).rejects.toThrow(/unauthenticated/);
    expect(queries).toHaveLength(0);
  });
});
