/**
 * The agent's half of the test-brief request store, against the real schema (`001_baseline.sql`):
 * what the morning brief may claim, and that a claimed request is never claimed again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { TEST_BRIEF_DAILY_MAX, TEST_BRIEF_WORKFLOW_TYPE } from "@lares/agent-kit/delivery";

import { quietPool } from "./helpers/quiet-pool.js";
import { claimTestBrief, finishTestBrief, testBriefClaimable } from "../lib/test-brief.js";

// The console's half writes through its own pool module; here that pool is this test's database,
// so the console's guarded insert and the agent's claim meet on the real schema.
vi.mock("../../console/lib/db", () => ({ get pool() { return db; } }));
import { askForTestBrief, latestTestBrief, testBriefView, ASKED, TEST_BRIEF_REFUSALS } from "../../console/lib/test-brief";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  db = quietPool(container.getConnectionUri());
  await db.query(sql("001_baseline.sql"));
}, 180_000);
afterAll(async () => { await db?.end(); await container?.stop(); });
beforeEach(async () => { await db.query("TRUNCATE workflow_jobs"); });

async function ask(o: { agent?: string; principal?: string; type?: string; door?: string; ageMinutes?: number; status?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workflow_jobs (agent, principal, workflow_type, state, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, now() - make_interval(mins => $6), now() - make_interval(mins => $6)) RETURNING id`,
    [o.agent ?? "chief", o.principal ?? "owner-1", o.type ?? TEST_BRIEF_WORKFLOW_TYPE,
      JSON.stringify({ kind: "morning-brief", door: o.door ?? "telegram" }), o.status ?? "pending", o.ageMinutes ?? 0],
  );
  return rows[0]!.id;
}
const statusOf = async (id: string) =>
  (await db.query<{ status: string; result: unknown; error: string | null }>("SELECT status, result, error FROM workflow_jobs WHERE id=$1", [id])).rows[0]!;

describe("claimTestBrief", () => {
  it("claims this agent's request from the owner, once", async () => {
    const id = await ask();
    expect(await claimTestBrief(db, "chief", "owner-1")).toEqual({ id, door: "telegram" });
    expect((await statusOf(id)).status).toBe("running");
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
  });

  it("never claims a row for another agent, another principal or another workflow type", async () => {
    const other = await ask({ agent: "other" });
    const stranger = await ask({ principal: "someone-else" });
    const job = await ask({ type: "some-other-job" });
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
    for (const id of [other, stranger, job]) expect((await statusOf(id)).status).toBe("pending");
  });

  it("never claims a stale request", async () => {
    const old = await ask({ ageMinutes: 11 });
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
    expect((await statusOf(old)).status).toBe("pending");
  });

  it("takes nothing while another test is running, and nothing beyond the daily limit", async () => {
    await ask({ status: "running" });
    const waiting = await ask();
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
    await db.query("TRUNCATE workflow_jobs");
    for (let i = 0; i < TEST_BRIEF_DAILY_MAX; i++) await ask({ status: "done", ageMinutes: 60 });
    const eleventh = await ask();
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
    expect((await statusOf(eleventh)).status).toBe("pending");
    expect(waiting).toBeTruthy();
  });

  it("a row with no usable door is closed, never sent and never claimed again", async () => {
    const id = await ask({ door: "web" });
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
    expect((await statusOf(id)).status).toBe("failed");
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
  });
});

describe("finishTestBrief", () => {
  it("sent is done with the hand-over time; anything else is failed with its code; a finished row is never claimed again", async () => {
    const a = await ask();
    await claimTestBrief(db, "chief", "owner-1");
    await finishTestBrief(db, a, { outcome: "sent", door: "telegram", sentAt: "2026-09-16T08:30:05.000Z" });
    expect(await statusOf(a)).toEqual({ status: "done", result: { outcome: "sent", door: "telegram", sentAt: "2026-09-16T08:30:05.000Z" }, error: null });

    const b = await ask();
    await claimTestBrief(db, "chief", "owner-1");
    await finishTestBrief(db, b, { outcome: "too-slow", door: "telegram" });
    expect(await statusOf(b)).toMatchObject({ status: "failed", error: "too-slow" });
    expect(await claimTestBrief(db, "chief", "owner-1")).toBeNull();
  });
});

describe("testBriefClaimable", () => {
  const at = (iso: string) => new Date(iso);
  it("is false at minute 0 of the brief hour and in the three minutes before it, on the owner's clock", () => {
    // Berlin is UTC+2 in September; the brief hour is 8.
    expect(testBriefClaimable(at("2026-09-16T05:56:00Z"), "Europe/Berlin", 8)).toBe(true);
    for (const m of ["57", "58", "59"]) expect(testBriefClaimable(at(`2026-09-16T05:${m}:00Z`), "Europe/Berlin", 8)).toBe(false);
    expect(testBriefClaimable(at("2026-09-16T06:00:00Z"), "Europe/Berlin", 8)).toBe(false);
    expect(testBriefClaimable(at("2026-09-16T06:01:00Z"), "Europe/Berlin", 8)).toBe(true);
  });
  it("wraps past midnight for a brief hour of 0", () => {
    expect(testBriefClaimable(at("2026-09-16T21:58:00Z"), "Europe/Berlin", 0)).toBe(false); // 23:58
    expect(testBriefClaimable(at("2026-09-16T21:50:00Z"), "Europe/Berlin", 0)).toBe(true);
  });
});

describe("the console's request and the agent's claim, on the real schema", () => {
  it("one request at a time, sent once, then the next may be asked for", async () => {
    expect(await askForTestBrief("chief", "owner-1", "slack")).toEqual({ ok: true });
    expect(await askForTestBrief("chief", "owner-1", "telegram")).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.busy });
    const claimed = await claimTestBrief(db, "chief", "owner-1");
    expect(claimed?.door).toBe("slack");
    expect(await askForTestBrief("chief", "owner-1", "telegram")).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.busy });
    await finishTestBrief(db, claimed!.id, { outcome: "sent", door: "slack", sentAt: new Date().toISOString() });
    expect(testBriefView(await latestTestBrief("chief"), new Date(), "UTC")?.text).toMatch(/^Sent to Slack at \d\d:\d\d\.$/);
    expect(await askForTestBrief("chief", "owner-1", "telegram")).toEqual({ ok: true });
    expect(testBriefView(await latestTestBrief("chief"), new Date(), "UTC")?.text).toBe(ASKED);
  });

  it("two presses at the same moment make one request", async () => {
    const both = await Promise.all([askForTestBrief("chief", "owner-1", "slack"), askForTestBrief("chief", "owner-1", "slack")]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM workflow_jobs")).rows[0].n).toBe(1);
  });

  it("the eleventh in 24 hours is refused, per agent", async () => {
    for (let i = 0; i < TEST_BRIEF_DAILY_MAX; i++) await ask({ status: "done", ageMinutes: 30 });
    expect(await askForTestBrief("chief", "owner-1", "slack")).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.tooMany });
    expect(await askForTestBrief("other", "owner-1", "slack")).toEqual({ ok: true });
  });

  it("a stale request no longer blocks a new one, and is never claimed", async () => {
    const old = await ask({ ageMinutes: 30 });
    expect(await askForTestBrief("chief", "owner-1", "telegram")).toEqual({ ok: true });
    expect((await claimTestBrief(db, "chief", "owner-1"))?.id).not.toBe(old);
  });
});
