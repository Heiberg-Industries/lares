/**
 * tests/memory-used-tool.test.ts — W5A-s5, the owner asks on a door which memories the previous
 * answer opened. Against a REAL disposable Postgres running the REAL migration file
 * (`memory_reads`, box 075), the house pattern (`tests/memory-reads.test.ts`,
 * `packages/agent-kit/tests/memory-read.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";

describe("memory_used — the answer on a door", () => {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;
  const migrationPath = join(import.meta.dirname, "../../box/sql/075_memory_reads.sql");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    dbUrl = container.getConnectionUri();
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query(readFileSync(migrationPath, "utf8"));
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(async () => {
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query("TRUNCATE memory_reads");
  });

  it("answers about the PREVIOUS turn, not the one asking the question", async () => {
    await getPool().query(
      `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref) VALUES
         ('s1', '',   'fixture-owner', 'standing_fact', '11'),
         ('s1', 't2', 'fixture-owner', 'vault_note',    'people/ada.md'),
         ('s1', 't9', 'fixture-owner', 'vault_note',    'other.md')`,
    );
    const tool = (await import("../catalogue/memory_used.js")).default;
    const out = await tool.execute({}, { session: { id: "s1", turn: { id: "t9" }, auth: null } } as never);
    expect(out.turn).toBe("t2");
    expect(out.used.map((u: { ref: string }) => u.ref)).toContain("people/ada.md");
    expect(out.used.map((u: { ref: string }) => u.ref)).toContain("11");
    expect(out.used.map((u: { ref: string }) => u.ref)).not.toContain("other.md");
    expect(out.summary).toContain("people/ada.md");
  });

  it("falls back to the current turn's own reads when there is no earlier turn", async () => {
    await getPool().query(
      `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref) VALUES
         ('s2', 't1', 'fixture-owner', 'agent_note', '3')`,
    );
    const tool = (await import("../catalogue/memory_used.js")).default;
    const out = await tool.execute({}, { session: { id: "s2", turn: { id: "t1" }, auth: null } } as never);
    expect(out.turn).toBe("t1");
    expect(out.used.map((u: { ref: string }) => u.ref)).toEqual(["3"]);
  });

  it("says a fixed sentence and an empty list when the previous answer opened nothing by id or path", async () => {
    const tool = (await import("../catalogue/memory_used.js")).default;
    const out = await tool.execute({}, { session: { id: "s3", turn: { id: "t1" }, auth: null } } as never);
    expect(out.used).toEqual([]);
    expect(out.summary).toMatch(/^Nothing recorded for that answer\./);
    expect(out.summary).toMatch(/searching/i);
  });

  it("says plainly when the installation records nothing yet", async () => {
    await getPool().query("DROP TABLE memory_reads");
    const tool = (await import("../catalogue/memory_used.js")).default;
    const out = await tool.execute({}, { session: { id: "s1", turn: { id: "t9" }, auth: null } } as never);
    expect(out.summary).toContain("075_memory_reads.sql");
    await getPool().query(readFileSync(migrationPath, "utf8"));
  });

  it("is registered five times over", async () => {
    const { CATALOGUE } = await import("../catalogue/index.js");
    expect(CATALOGUE["memory_used"]?.capability).toBe("vault");
    const { TOOL_CATEGORIES } = await import("@lares/agent-kit/always-ask");
    expect(TOOL_CATEGORIES["memory_used"]).toEqual([]);
    const { docFor } = await import("@lares/agent-kit/persona");
    expect(docFor("vault").tools).toContain("memory_used");
    // …and it is a FACTS tool: an agent granted only the note areas is not offered it.
    const { areaOfTool } = await import("@lares/agent-kit/always-ask");
    expect(areaOfTool("memory_used")).toBe("facts");
  });
});
