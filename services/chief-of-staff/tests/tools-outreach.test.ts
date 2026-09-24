import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";

import outreachTrack from "../catalogue/outreach_track.js";
import { getPool, closePool } from "@lares/agent-kit/db";

const ctx = {} as ToolContext;

/** Real, disposable Postgres — ORB-45 lesson: a fake Pool proves nothing. */
describe("outreach_track", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    const migration = readFileSync(join(import.meta.dirname, "../../box/sql/021_outreach_threads.sql"), "utf8");
    await getPool().query(migration);
    // Schema guard retrofit (023_schema_principal_scoping.sql) — applied inline since that
    // migration also touches telegram_* tables, which don't exist in this test's schema.
    await getPool().query(`ALTER TABLE outreach_threads ADD COLUMN principal text NOT NULL DEFAULT 'bendik';`);
    const retryMigration = readFileSync(join(import.meta.dirname, "../../box/sql/025_outreach_triage_checkpoint.sql"), "utf8");
    await getPool().query(retryMigration);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(async () => {
    await getPool().query("TRUNCATE outreach_threads");
  });

  it("is not gated — no approval config on the tool", () => {
    expect((outreachTrack as unknown as { approval?: unknown }).approval).toBeUndefined();
  });

  it("records a tracked thread and returns its id", async () => {
    const result = await outreachTrack.execute({ threadId: "th1", account: "owner@project.example", personId: "p1" }, ctx);
    expect(result).toMatchObject({ ok: true });
    const { rows } = await getPool().query("SELECT thread_id, account, person_id, status FROM outreach_threads");
    expect(rows).toEqual([{ thread_id: "th1", account: "owner@project.example", person_id: "p1", status: "awaiting_reply" }]);
  });

  it("works without a personId", async () => {
    await outreachTrack.execute({ threadId: "th1", account: "owner@project.example" }, ctx);
    const { rows } = await getPool().query("SELECT person_id FROM outreach_threads");
    expect(rows[0].person_id).toBeNull();
  });

  // ORB-93 — passes gmail_send's sentAt through to trackOutreachThread so the recorded send
  // time reflects the actual send, not whenever this (separate, later) tool call runs.
  it("passes sentAt through — the recorded send time is NOT this call's own now()", async () => {
    await outreachTrack.execute(
      { threadId: "th1", account: "owner@project.example", sentAt: "2026-08-16T10:00:00.000Z" }, ctx,
    );
    const { rows } = await getPool().query("SELECT sent_at FROM outreach_threads");
    expect(new Date(rows[0].sent_at).toISOString()).toBe("2026-08-16T09:59:30.000Z"); // minus the 30s skew allowance
  });
});
