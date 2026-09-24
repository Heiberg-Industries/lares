import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { findOrCreateSession } from "../lib/sessions.js";
import { createConfirmation, getConfirmation, resolveConfirmation, expireConfirmations, setConfirmationSlackRef, findConfirmationBySlackRef } from "../lib/confirmations.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";


let tdb: TestDb; let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

async function sess() { return (await findOrCreateSession(db, "saga", "slack", `c-${Math.random()}`)).id; }

describe("confirmations", () => {
  it("creates a pending confirmation and reads it back", async () => {
    const id = await createConfirmation(db, await sess(), "twenty.write", { name: "Acme" });
    const c = await getConfirmation(db, id);
    expect(c?.status).toBe("pending");
    expect(c?.action).toBe("twenty.write");
    expect(c?.args).toEqual({ name: "Acme" });
  });

  it("approves a pending confirmation exactly once", async () => {
    const id = await createConfirmation(db, await sess(), "twenty.write", {});
    const first = await resolveConfirmation(db, id, true);
    expect(first?.status).toBe("approved");
    const second = await resolveConfirmation(db, id, true);
    expect(second).toBeNull(); // already resolved — cannot double-fire
  });

  it("rejects a pending confirmation", async () => {
    const id = await createConfirmation(db, await sess(), "send_email", {});
    const r = await resolveConfirmation(db, id, false);
    expect(r?.status).toBe("rejected");
  });

  it("expires old pending rows", async () => {
    const id = await createConfirmation(db, await sess(), "x.y", {});
    const n = await expireConfirmations(db, new Date(Date.now() + 1000)); // everything older than 1s in the future
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await getConfirmation(db, id))?.status).toBe("expired");
  });
});

describe("confirmations with null session (workflow-originated)", () => {
  it("creates a confirmation with no session and reads its pending status", async () => {
    const id = await createConfirmation(db, null, "gmail.send", { to: "x@example.com" });
    const conf = await getConfirmation(db, id);
    expect(conf?.status).toBe("pending");
    expect(conf?.action).toBe("gmail.send");
  });

  it("resolve flips a null-session confirmation to approved and getConfirmation sees it", async () => {
    const id = await createConfirmation(db, null, "gmail.send", {});
    await resolveConfirmation(db, id, true);
    expect((await getConfirmation(db, id))?.status).toBe("approved");
  });
});

describe("confirmation slack ref (restart-safe approval link)", () => {
  it("records a Slack ref and looks the confirmation back up by (channel, ts)", async () => {
    const id = await createConfirmation(db, null, "gmail.send", {});
    await setConfirmationSlackRef(db, id, "C1", "1700.0001");
    const found = await findConfirmationBySlackRef(db, "C1", "1700.0001");
    expect(found).toBe(id);
  });

  it("returns null for an unknown (channel, ts) pair", async () => {
    const result = await findConfirmationBySlackRef(db, "CNONE", "0000.0000");
    expect(result).toBeNull();
  });

  it("does not change the confirmation status when setting the slack ref", async () => {
    const id = await createConfirmation(db, null, "gmail.send", {});
    await setConfirmationSlackRef(db, id, "C2", "1700.0002");
    const conf = await getConfirmation(db, id);
    expect(conf?.status).toBe("pending");
  });
});
