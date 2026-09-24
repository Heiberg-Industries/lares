import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { appendAudit } from "../lib/audit.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb; let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

describe("audit", () => {
  it("appends an audit row with a redacted summary, no raw args", async () => {
    await appendAudit(db, {
      agent: "saga", action: "twenty.write",
      credential: "twenty:write-with-confirm", argsSummary: "create company Acme",
    });
    const { rows } = await db.query(
      `SELECT agent, action, credential, args_summary, principal FROM audit WHERE action = 'twenty.write'`,
    );
    expect(rows[0].agent).toBe("saga");
    expect(rows[0].credential).toBe("twenty:write-with-confirm");
    expect(rows[0].args_summary).toBe("create company Acme");
    expect(rows[0].principal).toBeNull(); // non-breaking: callers that pass no principal write NULL
  });

  it("persists the principal who acted/approved", async () => {
    await appendAudit(db, {
      agent: "lab", action: "lab.note", argsSummary: "wrote a note", principal: "bendik",
    });
    const { rows } = await db.query("SELECT principal FROM audit WHERE agent = 'lab' LIMIT 1");
    expect(rows[0].principal).toBe("bendik");
  });
});
