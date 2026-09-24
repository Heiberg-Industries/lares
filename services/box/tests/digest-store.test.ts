import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  enqueueDigestRequest, claimDigestRequests,
  recordDigestSkip, listSkippedPaths,
} from "../lib/digest-store.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let db: TestDb;
beforeAll(async () => { db = await startTestDb(); }, 120_000);
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.pool.query("TRUNCATE digest_requests, digest_skips");
});

describe("digest request queue", () => {
  it("enqueues a request and claims it exactly once", async () => {
    await enqueueDigestRequest(db.pool, { agent: "saga", requestedBy: "U1", door: "slack", threadRef: "D9" });
    const first = await claimDigestRequests(db.pool, "saga");
    expect(first).toHaveLength(1);
    expect(first[0].door).toBe("slack");
    expect(first[0].threadRef).toBe("D9");
    const second = await claimDigestRequests(db.pool, "saga");
    expect(second).toHaveLength(0); // already consumed
  });

  it("only claims the named agent's requests", async () => {
    await enqueueDigestRequest(db.pool, { agent: "ada", requestedBy: "U1", door: "slack", threadRef: "X" });
    const claimed = await claimDigestRequests(db.pool, "saga");
    expect(claimed).toHaveLength(0);
  });
});

describe("digest skips", () => {
  it("records and lists skipped paths, idempotent per path", async () => {
    await recordDigestSkip(db.pool, { agent: "saga", path: "_inbox/Foo.md", reason: "ambiguous" });
    await recordDigestSkip(db.pool, { agent: "saga", path: "_inbox/Foo.md", reason: "still ambiguous" });
    const paths = await listSkippedPaths(db.pool, "saga");
    expect(paths).toEqual(["_inbox/Foo.md"]);
  });
});
