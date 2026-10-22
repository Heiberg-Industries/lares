/** Fixed-column startup check: migrations own the schema; runtime only verifies it exists. */
import { describe, it, expect } from "vitest";
import { ensureStudioTables } from "../lib/studio/store.js";

function fakeDb() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  return db;
}

describe("studio store schema check", () => {
  it("checks fixed columns without creating or altering tables", async () => {
    const db = fakeDb();
    await ensureStudioTables(db);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toMatch(/SELECT id, brief, consensus, spread, picks, principal, created_at, owner_member_id/);
    expect(db.calls[0]!.sql).toMatch(/LIMIT 0/);
    expect(db.calls[0]!.sql).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
    expect(db.calls[0]!.sql).not.toMatch(/studio_runs\s*\./);
    expect(db.calls[0]!.sql).not.toMatch(/\w+\.studio_runs/);
  });
});
