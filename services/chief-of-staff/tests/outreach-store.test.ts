import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { trackOutreachThread, listAwaitingReply, markReplied, stopTracking, beginTriage } from "../lib/outreach-store.js";

describe("outreach-store", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const migration = readFileSync(join(import.meta.dirname, "../../box/sql/021_outreach_threads.sql"), "utf8");
    await pool.query(migration);
    // Schema guard retrofit (023_schema_principal_scoping.sql) — applied inline since that
    // migration also touches telegram_* tables, which don't exist in this test's schema.
    await pool.query(`ALTER TABLE outreach_threads ADD COLUMN principal text NOT NULL DEFAULT 'bendik';`);
    const retryMigration = readFileSync(join(import.meta.dirname, "../../box/sql/025_outreach_triage_checkpoint.sql"), "utf8");
    await pool.query(retryMigration);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE outreach_threads");
  });

  describe("trackOutreachThread", () => {
    it("creates a new row anchored to 'awaiting_reply'", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example", personId: "p1" });
      expect(t).toMatchObject({ threadId: "th1", account: "owner@project.example", personId: "p1", status: "awaiting_reply" });
    });

    it("is idempotent on (threadId, account) — a repeat call does not create a duplicate", async () => {
      await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      const { rows } = await pool.query("SELECT count(*) FROM outreach_threads WHERE thread_id='th1'");
      expect(rows[0].count).toBe("1");
    });

    it("the same thread id under a DIFFERENT account is a separate row", async () => {
      await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await trackOutreachThread(pool, { threadId: "th1", account: "owner@owner.example" });
      const { rows } = await pool.query("SELECT count(*) FROM outreach_threads WHERE thread_id='th1'");
      expect(rows[0].count).toBe("2");
    });

    // ORB-93 — re-tracking used to be a total no-op (SET thread_id = thread_id), so a
    // follow-up send on an already-replied thread left status='replied' standing and the
    // next reply on it was never detected, even though the tool call reported {ok:true}.
    it("re-tracking an already-replied thread re-arms it to 'awaiting_reply'", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await markReplied(pool, t.id);
      await expect(listAwaitingReply(pool)).resolves.toEqual([]);

      const retracked = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      expect(retracked.id).toBe(t.id); // same row, not a new one
      expect(retracked.status).toBe("awaiting_reply");
      await expect(listAwaitingReply(pool)).resolves.toHaveLength(1);
    });

    it("re-tracking clears resolved_at and any stale triage checkpoint from the previous round", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await beginTriage(pool, t.id);
      await markReplied(pool, t.id);
      await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      const { rows } = await pool.query("SELECT resolved_at, triage_started_at FROM outreach_threads WHERE id = $1", [t.id]);
      expect(rows[0].resolved_at).toBeNull();
      expect(rows[0].triage_started_at).toBeNull();
    });

    it("re-tracking bumps sent_at to the new send time", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await pool.query("UPDATE outreach_threads SET sent_at = now() - interval '10 days' WHERE id = $1", [t.id]);
      const retracked = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      expect(retracked.sentAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    // ORB-93 — sent_at used to default to whenever THIS tool call ran (a separate, LATER
    // call than the actual send), so a very fast reply dated before that later moment never
    // satisfied detectReply's strictly-after filter. A caller-supplied sentAt (what
    // gmail_send returned) now anchors it instead, minus a small skew allowance.
    it("uses the given sentAt (minus a skew allowance) instead of now()", async () => {
      const sentAt = "2026-08-16T10:00:00.000Z";
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example", sentAt });
      // 30s skew allowance subtracted — a reply dated a few seconds "before" sentAt still counts.
      expect(t.sentAt.toISOString()).toBe("2026-08-16T09:59:30.000Z");
    });

    it("defaults to now() when no sentAt is given — unchanged behavior", async () => {
      const before = Date.now();
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      expect(t.sentAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(t.sentAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe("beginTriage", () => {
    it("claims a fresh (never-started) checkpoint", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await expect(beginTriage(pool, t.id)).resolves.toBe(true);
    });

    it("does not re-claim a checkpoint set moments ago — the in-flight guard", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await beginTriage(pool, t.id);
      await expect(beginTriage(pool, t.id)).resolves.toBe(false);
    });

    it("re-claims a stale checkpoint — the crash-recovery path", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      await beginTriage(pool, t.id);
      await pool.query("UPDATE outreach_threads SET triage_started_at = now() - interval '25 minutes' WHERE id = $1", [t.id]);
      await expect(beginTriage(pool, t.id)).resolves.toBe(true);
    });

    it("survives concurrent begins — only one wins", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "owner@project.example" });
      const results = await Promise.all(Array.from({ length: 5 }, () => beginTriage(pool, t.id)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("listAwaitingReply", () => {
    it("only returns awaiting_reply rows, oldest first", async () => {
      const a = await trackOutreachThread(pool, { threadId: "old", account: "x" });
      await pool.query("UPDATE outreach_threads SET sent_at = now() - interval '2 days' WHERE id = $1", [a.id]);
      const b = await trackOutreachThread(pool, { threadId: "new", account: "x" });
      await markReplied(pool, b.id);

      const list = await listAwaitingReply(pool);
      expect(list.map((t) => t.threadId)).toEqual(["old"]);
    });
  });

  describe("markReplied / stopTracking", () => {
    it("markReplied removes the row from the awaiting-reply list", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "x" });
      await markReplied(pool, t.id);
      await expect(listAwaitingReply(pool)).resolves.toEqual([]);
    });

    it("stopTracking also removes it, without marking replied", async () => {
      const t = await trackOutreachThread(pool, { threadId: "th1", account: "x" });
      await stopTracking(pool, t.id);
      await expect(listAwaitingReply(pool)).resolves.toEqual([]);
      const { rows } = await pool.query("SELECT status FROM outreach_threads WHERE id = $1", [t.id]);
      expect(rows[0].status).toBe("stopped");
    });
  });
});
