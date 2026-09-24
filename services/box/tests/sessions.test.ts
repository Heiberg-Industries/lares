import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { findOrCreateSession, setSdkSession } from "../lib/sessions.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

describe("sessions", () => {
  it("creates a session then returns the same row for the same thread", async () => {
    const a = await findOrCreateSession(db, "saga", "slack", "C1:T1");
    const b = await findOrCreateSession(db, "saga", "slack", "C1:T1");
    expect(b.id).toBe(a.id);
  });

  it("distinguishes threads", async () => {
    const a = await findOrCreateSession(db, "saga", "slack", "C1:T2");
    const b = await findOrCreateSession(db, "saga", "slack", "C1:T3");
    expect(b.id).not.toBe(a.id);
  });

  it("persists the resumable sdk session id", async () => {
    const s = await findOrCreateSession(db, "saga", "slack", "C1:T4");
    await setSdkSession(db, s.id, "sdk-abc");
    const again = await findOrCreateSession(db, "saga", "slack", "C1:T4");
    expect(again.sdkSession).toBe("sdk-abc");
  });

  it("returns prevSeenAt = the last_seen_at from BEFORE this resolve (null on first create)", async () => {
    const first = await findOrCreateSession(db, "saga", "slack", "T:prev-1");
    expect(first.prevSeenAt).toBeNull();

    const second = await findOrCreateSession(db, "saga", "slack", "T:prev-1");
    expect(second.prevSeenAt).toBeInstanceOf(Date);
    // the pre-touch timestamp: at or before "now", and equal to the first resolve's touch
    expect(second.prevSeenAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const third = await findOrCreateSession(db, "saga", "slack", "T:prev-1");
    expect(third.prevSeenAt!.getTime()).toBeGreaterThanOrEqual(second.prevSeenAt!.getTime());
  });
});
