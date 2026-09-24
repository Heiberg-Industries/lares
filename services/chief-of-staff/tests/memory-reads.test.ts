/**
 * W5A-s1 (ADR-0017 rule 6) — which remembered things one answer actually opened. Against a REAL
 * disposable Postgres running the REAL migration file, the house pattern
 * (`tests/memory-use.test.ts`, `tests/dream-store.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordRead, resetReadWarningForTests, READ_KINDS } from "../lib/memory-reads.js";

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  await db.query(readFileSync(join(__dirname, "../../box/sql/075_memory_reads.sql"), "utf8"));
}, 120_000);

afterAll(async () => { await db.end(); await container.stop(); });
beforeEach(async () => { await db.query("TRUNCATE memory_reads"); resetReadWarningForTests(); });

describe("memory_reads", () => {
  it("names the four kinds and nothing else", async () => {
    expect([...READ_KINDS]).toEqual(["standing_fact", "preference", "vault_note", "agent_note"]);
    await expect(
      db.query("INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref) VALUES ('s','t','fixture-owner','guess','1')"),
    ).rejects.toThrow(/memory_reads_kind_check/);
  });

  it("records one row per ref and collapses a repeat inside the same turn", async () => {
    await recordRead(db, { sessionId: "s1", turnId: "t1", owner: "fixture-owner", kind: "standing_fact", refs: ["1", "2"] });
    await recordRead(db, { sessionId: "s1", turnId: "t1", owner: "fixture-owner", kind: "standing_fact", refs: ["2", "3"] });
    const { rows } = await db.query<{ ref: string }>("SELECT ref FROM memory_reads ORDER BY ref");
    expect(rows.map((r) => r.ref)).toEqual(["1", "2", "3"]);
  });

  it("keeps the session block apart from a turn, under turn_id ''", async () => {
    await recordRead(db, { sessionId: "s1", turnId: "", owner: "fixture-owner", kind: "standing_fact", refs: ["9"] });
    await recordRead(db, { sessionId: "s1", turnId: "t1", owner: "fixture-owner", kind: "vault_note", refs: ["people/x.md"] });
    const { rows } = await db.query<{ turn_id: string; ref: string }>(
      "SELECT turn_id, ref FROM memory_reads ORDER BY turn_id",
    );
    expect(rows).toEqual([{ turn_id: "", ref: "9" }, { turn_id: "t1", ref: "people/x.md" }]);
  });

  it("never throws when the table is missing, and never costs the turn", async () => {
    await db.query("DROP TABLE memory_reads");
    await expect(
      recordRead(db, { sessionId: "s", turnId: "t", owner: "fixture-owner", kind: "standing_fact", refs: ["1"] }),
    ).resolves.toBeUndefined();
    await db.query(readFileSync(join(__dirname, "../../box/sql/075_memory_reads.sql"), "utf8"));
  });

  it("does nothing at all for an empty ref list", async () => {
    await recordRead(db, { sessionId: "s", turnId: "t", owner: "fixture-owner", kind: "standing_fact", refs: [] });
    const { rows } = await db.query("SELECT 1 FROM memory_reads");
    expect(rows).toHaveLength(0);
  });
});
