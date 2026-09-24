// services/box/tests/task-state.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { findOrCreateSession } from "../lib/sessions.js";
import { setTaskState, getTaskState } from "../lib/task-state.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb; let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

describe("task_state", () => {
  it("round-trips per-task checkpoint state", async () => {
    const s = await findOrCreateSession(db, "saga", "slack", "C1:TS1");
    expect(await getTaskState(db, s.id)).toBeNull();
    await setTaskState(db, s.id, { done: [1, 2, 3], pending: [4, 5] });
    expect(await getTaskState(db, s.id)).toEqual({ done: [1, 2, 3], pending: [4, 5] });
  });
});
