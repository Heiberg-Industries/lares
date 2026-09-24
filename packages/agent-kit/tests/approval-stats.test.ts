import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answeredRate, couldActOnItsOwn, GRADUATION_MIN_ASKS, GRADUATION_MIN_DAYS, readApprovalCounts,
} from "../src/approval-stats.js";
import type { ApprovalCount } from "../src/approval-stats.js";
import type { AskOutcome } from "../src/approval-ledger.js";
import { mustAlwaysAsk } from "../src/always-ask.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL = join(here, "..", "..", "..", "services", "box", "sql", "086_approval_asks.sql");

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  // CI FLAKE FIXED (WAVE-3-NOTES): a Pool with no 'error' listener turns a stopped container's
  // idle-client error into an uncaught exception that fails the run. Register both, the way
  // packages/agent-kit/tests/approval-ledger.test.ts does.
  db.on("error", () => undefined);
  db.on("connect", (client) => client.on("error", () => undefined));
  await db.query(readFileSync(SQL, "utf8"));
}, 120_000);
afterAll(async () => { await db.end(); await container.stop(); });
beforeEach(async () => { await db.query("TRUNCATE approval_asks"); });

let seq = 0;
/** Inserts one approval_asks row per entry, raw, so the arithmetic under test never touches
 *  recordAsk/recordAnswer (that pair is approval-ledger's own test's job). */
async function seed(
  rows: Array<{ tool: string; outcome: AskOutcome | null; agent?: string; askedAt?: Date }>,
): Promise<void> {
  for (const r of rows) {
    seq += 1;
    await db.query(
      `INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash, asked_at, answered_at, outcome)
       VALUES ($1, $2, $3, $4, 'h', $5, $6, $7)`,
      [
        `req-${seq}`,
        `call-${seq}`,
        r.agent ?? "fixture-agent",
        r.tool,
        r.askedAt ?? new Date(),
        r.outcome === null ? null : new Date(),
        r.outcome,
      ],
    );
  }
}

const NOW = new Date("2026-09-20T00:00:00Z");

/** Builds an `ApprovalCount` fixture for `couldActOnItsOwn`, never touching the database — the
 *  arithmetic under test here is pure, the same way `answeredRate`'s own tests are. */
function count(opts: { tool: string; asked: number; approved: number; cancelled?: number; days: number; agent?: string }): ApprovalCount {
  const cancelled = opts.cancelled ?? 0;
  return {
    agent: opts.agent ?? "fixture-agent",
    tool: opts.tool,
    asked: opts.asked,
    approved: opts.approved,
    cancelled,
    neverAnswered: opts.asked - opts.approved - cancelled,
    firstAt: new Date(NOW.getTime() - opts.days * 24 * 60 * 60 * 1000),
    lastAt: NOW,
  };
}

describe("approval stats", () => {
  it("counts what was asked, answered and never answered, per tool", async () => {
    await seed([
      { tool: "gmail_send", outcome: "approved" }, { tool: "gmail_send", outcome: "approved" },
      { tool: "gmail_send", outcome: "cancelled" }, { tool: "gmail_send", outcome: null },
      { tool: "calendar_delete_event", outcome: "expired" },
    ]);
    const counts = await readApprovalCounts(db);
    const send = counts.find((c) => c.tool === "gmail_send")!;
    expect(send).toMatchObject({ asked: 4, approved: 2, cancelled: 1, neverAnswered: 1 });
    expect(answeredRate(send)).toBeCloseTo(2 / 3);
    const del = counts.find((c) => c.tool === "calendar_delete_event")!;
    expect(del).toMatchObject({ asked: 1, approved: 0, cancelled: 0, neverAnswered: 1 });
    expect(answeredRate(del)).toBeNull();
  });

  it("an expired or ignored card is never counted as a refusal", () => {
    expect(answeredRate({ approved: 0, cancelled: 0 })).toBeNull();
    expect(answeredRate({ approved: 3, cancelled: 0 })).toBe(1);
  });

  it("ignores anything older than the window", async () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await seed([{ tool: "gmail_send", outcome: "approved", askedAt: longAgo }]);
    const counts = await readApprovalCounts(db);
    expect(counts.find((c) => c.tool === "gmail_send")).toBeUndefined();
  });

  it("answers [] on a box that has not applied 086", async () => {
    await db.query("DROP TABLE approval_asks");
    await expect(readApprovalCounts(db)).resolves.toEqual([]);
    await db.query(readFileSync(SQL, "utf8"));
  });
});

describe("couldActOnItsOwn — a suggestion, never applied", () => {
  it("suggests a tool the owner has approved every time, for long enough", () => {
    expect(couldActOnItsOwn([count({ tool: "remind_set", asked: 12, approved: 12, days: 40 })], NOW))
      .toEqual([{ agent: "fixture-agent", tool: "remind_set", asked: 12, sinceDays: 40 }]);
  });

  it("never suggests a tool a rule locks — money, deleting, first contact, publishing, its own autonomy", () => {
    const locked = ["calendar_delete_event", "gmail_send", "forget", "meeting_followup_auto", "agent-kit__vault_drop"];
    for (const tool of locked) {
      expect(mustAlwaysAsk(tool).ask, tool).toBe(true);
      expect(couldActOnItsOwn([count({ tool, asked: 50, approved: 50, days: 200 })], NOW), tool).toEqual([]);
    }
  });

  it("says nothing on one refusal, on too few cards, or on too short a history", () => {
    expect(couldActOnItsOwn([count({ tool: "remind_set", asked: 20, approved: 19, cancelled: 1, days: 90 })], NOW)).toEqual([]);
    expect(couldActOnItsOwn([count({ tool: "remind_set", asked: 9, approved: 9, days: 90 })], NOW)).toEqual([]);
    expect(couldActOnItsOwn([count({ tool: "remind_set", asked: 30, approved: 30, days: 10 })], NOW)).toEqual([]);
  });

  it("uses the plan's own numbers for the bar", () => {
    expect(GRADUATION_MIN_ASKS).toBe(10);
    expect(GRADUATION_MIN_DAYS).toBe(30);
  });
});
