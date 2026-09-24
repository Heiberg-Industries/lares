import { describe, it, expect, vi } from "vitest";

// getNotionSyncStatus queries through the module's shared pool; give it one whose
// .query always rejects so the "DB hiccup" / "not migrated yet" path is exercised
// without a real database. Mirrors the pattern in tests/account-oauth.test.ts.
vi.mock("../lib/db", () => ({
  pool: { query: () => Promise.reject(new Error('relation "notion_sync_docs" does not exist')) },
}));

import { toNotionSyncDTO, getNotionSyncStatus } from "../lib/queries";

describe("toNotionSyncDTO", () => {
  // The five states are not one kind of thing. `unmatched` is a settled fact — a Notion meeting
  // row with no matching calendar event — and summing it with a real queue produced a tile that
  // read "38 need attention" permanently. Split by whether a human can act.
  it("splits the states by whether you can act on them", () => {
    const dto = toNotionSyncDTO(
      { synced: 40, unmatched: 38, frozen: 1, error: 2, retrying: 4 },
      new Date("2026-08-03T09:05:00.000Z"),
    );
    expect(dto).toEqual({
      lastRunAt: "2026-08-03T09:05:00.000Z",
      synced: 40,
      needsYou: 3,      // frozen + error — blocks until a human runs `notion-sync resolve`
      retrying: 4,      // transient, self-healing
      unmatched: 38,    // settled fact, not a queue
    });
  });

  it("no longer reports a needsAttention total", () => {
    const dto = toNotionSyncDTO(
      { synced: 1, unmatched: 1, frozen: 1, error: 1, retrying: 1 },
      null,
    );
    expect(dto).not.toHaveProperty("needsAttention");
  });

  it("reports a null lastRunAt when the job has never run", () => {
    const dto = toNotionSyncDTO(
      { synced: 0, unmatched: 0, frozen: 0, error: 0, retrying: 0 },
      null,
    );
    expect(dto.lastRunAt).toBeNull();
    expect(dto.needsYou).toBe(0);
  });
});

describe("getNotionSyncStatus", () => {
  it("degrades to an unavailable DTO instead of throwing when the query fails", async () => {
    const dto = await getNotionSyncStatus();
    expect(dto).toEqual({
      lastRunAt: null,
      synced: 0,
      needsYou: 0,
      retrying: 0,
      unmatched: 0,
      unavailable: true,
    });
  });
});
