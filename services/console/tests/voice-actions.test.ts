import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../lib/db", () => ({ pool: { query: vi.fn(async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; }) } }));
vi.mock("../lib/auth", () => ({ verify: vi.fn(async () => "owner@owner.example") }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveCard, acceptProposed, setExampleIncluded, requestRelearn } from "../app/actions/voice";

beforeEach(() => { queries.length = 0; });

describe("voice actions", () => {
  it("saveCard updates the card columns of the named card (default needs no lookup)", async () => {
    await saveCard({ id: "default", core: "C", english: "E", norsk: "N" });
    expect(queries[0].sql).toMatch(/update voice_profile/i);
    expect(queries[0].params).toEqual(["C", "E", "N", "owner@owner.example", "default"]);
  });
  it("saveCard refuses an id that is not default and not an existing row — a typo must not create a card", async () => {
    await expect(saveCard({ id: "nobody@nowhere.tld", core: "C", english: "E", norsk: "N" })).rejects.toThrow(/unknown voice card/);
    expect(queries.some((q) => /update voice_profile/i.test(q.sql))).toBe(false);
  });
  it("acceptProposed promotes proposed → active and clears it, on the named card", async () => {
    await acceptProposed({ id: "default" });
    expect(queries[0].sql).toMatch(/proposed->>'core'/i);
    expect(queries[0].sql).toMatch(/proposed = NULL/i);
    expect(queries[0].params).toEqual(["owner@owner.example", "default"]);
  });
  it("setExampleIncluded toggles one row", async () => {
    await setExampleIncluded({ id: "a", included: false });
    expect(queries[0].params).toEqual(["a", false]);
  });
  it("requestRelearn stamps relearn_requested_at", async () => {
    await requestRelearn();
    expect(queries[0].sql).toMatch(/relearn_requested_at = now\(\)/i);
  });
});
