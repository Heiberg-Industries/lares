import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createReminder, dueReminders, markDelivered, listPending } from "../lib/reminders.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb;
let db: Pool;

// Pulling a container + applying the schema can take a moment on a cold image.
beforeAll(async () => {
  tdb = await startTestDb();
  db = tdb.pool;
}, 120_000);

afterAll(async () => {
  await tdb?.stop();
});

describe("reminders", () => {
  it("creates a one-shot reminder and finds it when due", async () => {
    const r = await createReminder(db, {
      agent: "saga",
      owner: "bendik",
      dueAt: new Date(Date.now() - 1000),
      payload: { text: "ping", door: "slack", threadRef: "T1" },
      createdBy: "sess-1",
    });
    const due = await dueReminders(db, new Date());
    expect(due.map((x) => x.id)).toContain(r.id);
  });

  it("marks a reminder delivered so it stops being due", async () => {
    const r = await createReminder(db, {
      agent: "saga",
      owner: "bendik",
      dueAt: new Date(Date.now() - 1000),
      payload: { text: "x", door: "slack", threadRef: "T2" },
      createdBy: "sess-1",
    });
    await markDelivered(db, r.id);
    const due = await dueReminders(db, new Date());
    expect(due.map((x) => x.id)).not.toContain(r.id);
  });

  it("does not return reminders that are not yet due", async () => {
    const r = await createReminder(db, {
      agent: "saga",
      owner: "bendik",
      dueAt: new Date(Date.now() + 60_000),
      payload: { text: "future", door: "slack", threadRef: "T3" },
      createdBy: "sess-1",
    });
    const due = await dueReminders(db, new Date());
    expect(due.map((x) => x.id)).not.toContain(r.id);
  });

  it("listPending returns created_by on each pending reminder", async () => {
    await createReminder(db, {
      agent: "saga",
      owner: "list-test-owner",
      dueAt: new Date(Date.now() + 3_600_000),
      payload: { text: "user reminder", door: "slack", threadRef: "T4" },
      createdBy: "user",
    });
    await createReminder(db, {
      agent: "saga",
      owner: "list-test-owner",
      dueAt: new Date(Date.now() + 3_600_000),
      payload: { text: "dream summary", door: "slack", threadRef: "T5" },
      createdBy: "saga-dream",
    });
    const pending = await listPending(db, "list-test-owner");
    expect(pending.length).toBeGreaterThanOrEqual(2);
    // Every row must carry created_by
    for (const r of pending) {
      expect(typeof r.created_by).toBe("string");
    }
    const createdBys = pending.map((r) => r.created_by);
    expect(createdBys).toContain("user");
    expect(createdBys).toContain("saga-dream");
  });
});
