/**
 * The ORIGIN class a door turn carries, and the write itself — ADR-0020
 * (docs/decisions/0020-conversations.md).
 *
 * "which class a door turn carries" is a pure function, no database — `originForTurn` is
 * exported from lib/turn-capture.ts precisely so this can be driven without one. Everything
 * below it proves the write against a REAL disposable Postgres running the REAL migration file
 * (the house pattern; see tests/standing-facts.test.ts's own header and the ORB-45 lesson it
 * cites: a fake Pool that never executes SQL is the "built+tested+non-functional" defect class
 * this project has already been bitten by): that a captured turn lands a row in
 * `conversation_entries` with the fields ADR-0020 rule 2 and LAR-21 need, and that an
 * installation which has not applied migration 060 — or whose database stalls — costs the
 * conversation record, never the turn, per the hold in lib/turn-capture.ts's module header.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

import { resetTaintForTests, taintTurn } from "@lares/agent-kit/origin-taint";
import { makeConversationRecord } from "@lares/agent-kit/conversation-record";
import {
  captureTurn,
  originForTurn,
  resetMissingTableWarnForTests,
  CONVERSATION_RECORD_TIMEOUT_MS,
} from "../lib/turn-capture.js";

const key = { sessionId: "s1", turnId: "t1" };
beforeEach(() => resetTaintForTests());

describe("which class a door turn carries", () => {
  it("a human turn with nothing read is owner", () => {
    expect(originForTurn(undefined, key)).toBe("owner");
  });

  it("a scheduled lane is system", () => {
    expect(originForTurn("morning-brief", key)).toBe("system");
  });

  it("a human turn that read an email is third_party — the summary does not launder it", () => {
    taintTurn(key, "third_party");
    expect(originForTurn(undefined, key)).toBe("third_party");
  });

  it("a scheduled turn that read an email is third_party too", () => {
    taintTurn(key, "third_party");
    expect(originForTurn("morning-brief", key)).toBe("third_party");
  });

  it("a live Notion read narrows a human turn to synced, not third_party", () => {
    taintTurn(key, "synced");
    expect(originForTurn(undefined, key)).toBe("synced");
  });

  it("a turn with no usable key fails closed", () => {
    expect(originForTurn(undefined, undefined)).toBe("third_party");
  });
});

const base = {
  at: "2026-09-18T10:00:00.000Z",
  door: "slack",
  principal: "fixture-owner",
  sessionId: "s1",
  turnId: "t1",
  origin: "owner" as const,
  input: "hello",
  reply: "hi",
  proposals: [],
};

// No DATABASE_URL, no container: `hanging` never resolves at all, so this proves the timeout
// bound on its own terms, the same way tests/standing-facts.test.ts proves STANDING_FACTS_TIMEOUT_MS
// against a stalled pool.
describe("captureTurn — a slow conversation-record write costs the record, never the turn", () => {
  it("resolves within the write's budget, never hangs on a stalled sink", async () => {
    const hanging = { append: () => new Promise<never>(() => {}) };
    const startedAt = Date.now();
    await expect(captureTurn(base, hanging)).resolves.toBeUndefined();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(CONVERSATION_RECORD_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(CONVERSATION_RECORD_TIMEOUT_MS + 3_000);
  });
});

describe("captureTurn writes the conversation record — real Postgres, real migration 060", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const migrationSql = readFileSync(
    join(import.meta.dirname, "../../box/sql/060_conversation_entries.sql"),
    "utf8",
  );

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(migrationSql);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE conversation_entries");
    resetMissingTableWarnForTests();
  });

  it("lands one row with the entry's origin, person key and lane", async () => {
    const record = makeConversationRecord(pool);
    await captureTurn({ ...base, lane: "morning-brief", origin: "system" }, record);

    const { rows } = await pool.query("SELECT * FROM conversation_entries");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "unknown",
      session_id: "s1",
      turn_id: "t1",
      door: "slack",
      person_key: "fixture-owner",
      lane: "morning-brief",
      origin: "system",
      input: "hello",
      reply: "hi",
    });
  });

  it("reads LARES_AGENT_NAME at call time, never at module scope", async () => {
    const record = makeConversationRecord(pool);
    const prior = process.env["LARES_AGENT_NAME"];
    process.env["LARES_AGENT_NAME"] = "canary";
    try {
      await captureTurn(base, record);
    } finally {
      if (prior === undefined) delete process.env["LARES_AGENT_NAME"];
      else process.env["LARES_AGENT_NAME"] = prior;
    }
    const { rows } = await pool.query("SELECT agent FROM conversation_entries");
    expect(rows[0].agent).toBe("canary");
  });

  it("a human turn (no lane) stores a NULL lane, not a string", async () => {
    const record = makeConversationRecord(pool);
    await captureTurn(base, record);
    const { rows } = await pool.query("SELECT lane FROM conversation_entries");
    expect(rows[0].lane).toBeNull();
  });

  // FAIL SOFT, ALWAYS. An installation that has not applied 060 yet must still get its reply —
  // and must not be warned about it once per turn forever.
  it("fails soft when conversation_entries does not exist, and throttles the warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pool.query("DROP TABLE conversation_entries");
    try {
      const record = makeConversationRecord(pool);
      await expect(captureTurn(base, record)).resolves.toBeUndefined();
      await expect(captureTurn(base, record)).resolves.toBeUndefined();
      const missingTableWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("conversation_entries does not exist"),
      );
      // Logged loudly once per process, not once per turn — the second call within the same
      // process must not repeat it.
      expect(missingTableWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await pool.query(migrationSql);
    }
  });
});
