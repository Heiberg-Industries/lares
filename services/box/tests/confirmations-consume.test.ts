import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "./helpers/pg.js";
import { createConfirmation, getConfirmation, resolveConfirmation, consumeConfirmation, markConfirmationConsumed } from "../lib/confirmations.js";

let tdb: TestDb; let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

async function approved(): Promise<string> {
  const id = await createConfirmation(db, null, "gmail.send", { to: "x@y.no" });
  await resolveConfirmation(db, id, true); // pending → approved
  return id;
}

describe("confirmation consume", () => {
  it("consumeConfirmation atomically claims approved→consuming for a single winner", async () => {
    const id = await approved();
    const first = await consumeConfirmation(db, id);
    const second = await consumeConfirmation(db, id);
    expect(first?.id).toBe(id);
    expect(first?.status).toBe("consuming");
    expect(second).toBeNull();                              // already consuming → no second winner
  });
  it("consumeConfirmation returns null when not approved", async () => {
    const id = await createConfirmation(db, null, "gmail.send", {}); // still pending
    expect(await consumeConfirmation(db, id)).toBeNull();
  });
  it("markConfirmationConsumed stores the result and flips consuming→consumed", async () => {
    const id = await approved();
    await consumeConfirmation(db, id);
    await markConfirmationConsumed(db, id, { gmailThreadId: "t-1" });
    const conf = await getConfirmation(db, id);
    expect(conf?.status).toBe("consumed");
    expect(conf?.effectResult).toEqual({ gmailThreadId: "t-1" });
  });
});
