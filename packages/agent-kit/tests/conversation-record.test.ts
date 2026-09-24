import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  makeConversationRecord,
  DEFAULT_RETENTION_MONTHS,
  readRetentionMonths,
  writeRetentionMonths,
  cutoffFor,
  pruneForOwner,
} from "../src/conversation-record.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "box", "sql");
const migration = readFileSync(join(sqlDir, "060_conversation_entries.sql"), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(migration);
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.stop(); });
beforeEach(async () => { await pool.query("TRUNCATE conversation_entries"); });

const base = {
  agent: "canary", sessionId: "s1", turnId: "t1", door: "slack",
  personKey: "fixture-owner", origin: "owner" as const,
  input: "hello", reply: "hi", proposals: ["calendar.create_event"],
  at: new Date("2026-09-18T10:00:00Z"),
};

describe("conversation_entries", () => {
  it("applies cleanly twice", async () => { await pool.query(migration); });

  it("appends and reads back every field", async () => {
    const r = makeConversationRecord(pool);
    const row = await r.append(base);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.origin).toBe("owner");
    expect(row.proposals).toEqual(["calendar.create_event"]);
    expect(row.lane).toBeNull();
    expect(row.at.toISOString()).toBe("2026-09-18T10:00:00.000Z");
  });

  it("is append-only: the same turn twice is two rows, not an overwrite", async () => {
    const r = makeConversationRecord(pool);
    await r.append(base);
    await r.append({ ...base, reply: "corrected" });
    const { rows } = await pool.query("SELECT reply FROM conversation_entries ORDER BY recorded_at");
    expect(rows.map((x) => x.reply)).toEqual(["hi", "corrected"]);
  });

  it("refuses a class that is not one of the five", async () => {
    await expect(
      pool.query(
        "INSERT INTO conversation_entries (agent, session_id, turn_id, door, person_key, origin, input, reply, proposals, at) VALUES ('a','s','t','slack','p','hearsay','i','r','{}',now())",
      ),
    ).rejects.toThrow(/conversation_entries_origin_check/);
  });

  it("since() is strict and ordered", async () => {
    const r = makeConversationRecord(pool);
    await r.append({ ...base, turnId: "t1", at: new Date("2026-09-18T10:00:00Z") });
    await r.append({ ...base, turnId: "t2", at: new Date("2026-09-18T11:00:00Z") });
    const got = await r.since({ agent: "canary", since: new Date("2026-09-18T10:00:00Z") });
    expect(got.map((e) => e.turnId)).toEqual(["t2"]);
  });

  it("since({excludeLanes}) drops scheduled turns, the way the dream cycle needs", async () => {
    const r = makeConversationRecord(pool);
    await r.append({ ...base, turnId: "t1", lane: "morning-brief", origin: "system" });
    await r.append({ ...base, turnId: "t2", at: new Date("2026-09-18T11:00:00Z") });
    const got = await r.since({ agent: "canary", since: new Date("2026-09-18T09:00:00Z"), excludeLanes: true });
    expect(got.map((e) => e.turnId)).toEqual(["t2"]);
  });

  it("forPerson finds one person's entries and nobody else's", async () => {
    const r = makeConversationRecord(pool);
    await r.append(base);
    await r.append({ ...base, turnId: "t2", personKey: "someone-else" });
    expect((await r.forPerson("fixture-owner")).map((e) => e.turnId)).toEqual(["t1"]);
  });

  it("pruneBefore removes only what is older and reports how many", async () => {
    const r = makeConversationRecord(pool);
    await r.append({ ...base, turnId: "old", at: new Date("2025-01-01T00:00:00Z") });
    await r.append({ ...base, turnId: "new" });
    expect(await r.pruneBefore(new Date("2026-01-01T00:00:00Z"))).toBe(1);
    const { rows } = await pool.query("SELECT turn_id FROM conversation_entries");
    expect(rows.map((x) => x.turn_id)).toEqual(["new"]);
  });
});

describe("retention", () => {
  it("061 applies cleanly twice", async () => {
    const sql = readFileSync(join(sqlDir, "061_conversation_retention.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql);
  });

  it("no row means twelve months", async () => {
    expect(await readRetentionMonths(pool, "fixture-owner")).toBe(12);
    expect(DEFAULT_RETENTION_MONTHS).toBe(12);
  });

  it("keep forever is a real, storable answer", async () => {
    await writeRetentionMonths(pool, "fixture-owner", null, "console");
    expect(await readRetentionMonths(pool, "fixture-owner")).toBeNull();
  });

  it("a shorter window stores and reads back", async () => {
    await writeRetentionMonths(pool, "fixture-owner", 3, "console");
    expect(await readRetentionMonths(pool, "fixture-owner")).toBe(3);
  });

  it("refuses zero and negatives at the database, not only in code", async () => {
    await expect(
      pool.query("INSERT INTO conversation_retention (owner, months) VALUES ('x', 0)"),
    ).rejects.toThrow(/conversation_retention_months_check/);
    await expect(
      pool.query("INSERT INTO conversation_retention (owner, months) VALUES ('y', -1)"),
    ).rejects.toThrow(/conversation_retention_months_check/);
  });

  it("cutoffFor is exact, and undefined for keep-forever", () => {
    expect(cutoffFor(12, new Date("2026-09-18T00:00:00Z"))!.toISOString()).toBe("2025-09-18T00:00:00.000Z");
    expect(cutoffFor(null, new Date("2026-09-18T00:00:00Z"))).toBeUndefined();
  });
});

describe("pruneForOwner prunes memory_reads with the conversation it belongs to", () => {
  it("prunes a person's read records on the same cutoff as their conversation", async () => {
    await pool.query(readFileSync(join(sqlDir, "075_memory_reads.sql"), "utf8"));
    await pool.query(
      `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref, at) VALUES
         ('old', 't1', 'fixture-owner', 'standing_fact', '1', now() - interval '400 days'),
         ('new', 't1', 'fixture-owner', 'standing_fact', '2', now())`,
    );
    const out = await pruneForOwner(pool, { owner: "fixture-owner", now: new Date() });
    expect(out.deletedReads).toBe(1);
    const { rows } = await pool.query<{ session_id: string }>("SELECT session_id FROM memory_reads");
    expect(rows.map((r) => r.session_id)).toEqual(["new"]);
  });

  it("deletes no read record when retention is 'keep forever'", async () => {
    await writeRetentionMonths(pool, "fixture-owner", null, "test");
    const out = await pruneForOwner(pool, { owner: "fixture-owner", now: new Date() });
    expect(out.outcome).toBe("kept-forever");
    expect(out.deletedReads).toBe(0);
  });

  it("survives a box that has not applied 075", async () => {
    await writeRetentionMonths(pool, "fixture-owner", 12, "test");
    await pool.query("DROP TABLE memory_reads");
    const out = await pruneForOwner(pool, { owner: "fixture-owner", now: new Date() });
    expect(out.outcome).toBe("pruned");
    expect(out.deletedReads).toBe(0);
  });
});
