import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { getEmailWatchCursor, advanceEmailWatchCursor } from "../lib/email-watch-cursors.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

describe("email watch cursors", () => {
  it("returns 0 for an unseen mailbox", async () => {
    expect(await getEmailWatchCursor(db, "saga-email", "U_BENDIK", "new@owner.example")).toBe(0);
  });

  it("upserts and reads back the watermark", async () => {
    await advanceEmailWatchCursor(db, "saga-email", "U_BENDIK", "owner@owner.example", 1719_000_000);
    expect(await getEmailWatchCursor(db, "saga-email", "U_BENDIK", "owner@owner.example")).toBe(1719_000_000);
  });

  it("never moves the watermark backwards", async () => {
    await advanceEmailWatchCursor(db, "saga-email", "U_BENDIK", "owner@project.example", 2000);
    await advanceEmailWatchCursor(db, "saga-email", "U_BENDIK", "owner@project.example", 1000);  // older
    expect(await getEmailWatchCursor(db, "saga-email", "U_BENDIK", "owner@project.example")).toBe(2000);
  });

  it("keys cursors independently per (watcher, principal, mailbox)", async () => {
    await advanceEmailWatchCursor(db, "saga-email", "U_BENDIK", "shared@owner.example", 50);
    await advanceEmailWatchCursor(db, "other-watcher", "U_BENDIK", "shared@owner.example", 99);
    expect(await getEmailWatchCursor(db, "saga-email", "U_BENDIK", "shared@owner.example")).toBe(50);
    expect(await getEmailWatchCursor(db, "other-watcher", "U_BENDIK", "shared@owner.example")).toBe(99);
  });
});
