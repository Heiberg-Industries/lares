import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { quiet } from "./helpers/quiet-pool.js";
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
const migration = readFileSync(join(sqlDir, "001_baseline.sql"), "utf8");
const audienceMigration = readFileSync(join(sqlDir, "030_conversation_audience.sql"), "utf8");
const webInboxMigration = readFileSync(join(sqlDir, "004_web_inbox.sql"), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  await pool.query(migration);
  await pool.query(webInboxMigration);
  await pool.query(audienceMigration);
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

  it("the audience migration is safe to apply again", async () => {
    await expect(pool.query(audienceMigration)).resolves.toBeDefined();
    await makeConversationRecord(pool).append({
      ...base, audienceMemberId: "fixture-owner", audienceAddress: "slack-user:fixture", audienceAccessRevision: 7,
    });
  });

  it("appends and reads back every field", async () => {
    const r = makeConversationRecord(pool);
    const row = await r.append({ ...base, audienceMemberId: "fixture-owner", audienceAddress: "slack-user:fixture", audienceAccessRevision: 7 });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.origin).toBe("owner");
    expect(row.proposals).toEqual(["calendar.create_event"]);
    expect(row.lane).toBeNull();
    expect(row.audienceMemberId).toBe("fixture-owner");
    expect(row.audienceAddress).toBe("slack-user:fixture");
    expect(row.audienceAccessRevision).toBe(7);
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

  it("continuity is restricted to a captured private member, address, door and trusted origins", async () => {
    const r = makeConversationRecord(pool);
    const privateRow = { ...base, audienceMemberId: "fixture-owner", audienceAddress: "slack-user:fixture", audienceAccessRevision: 7 };
    await r.append(privateRow);
    await r.append({ ...privateRow, turnId: "other-member", audienceMemberId: "someone-else" });
    await r.append({ ...privateRow, turnId: "other-door", door: "telegram" });
    await r.append({ ...privateRow, turnId: "legacy", audienceMemberId: null, audienceAddress: null, audienceAccessRevision: null });
    await r.append({ ...privateRow, turnId: "untrusted", origin: "third_party" });
    await r.append({ ...privateRow, turnId: "proactive-1", origin: "system", lane: "brief", at: new Date("2026-09-18T10:01:00Z") });
    await r.append({ ...privateRow, turnId: "proactive-2", origin: "system", lane: "brief", at: new Date("2026-09-18T10:02:00Z") });
    await r.append({ ...privateRow, turnId: "proactive-3", origin: "system", lane: "brief", at: new Date("2026-09-18T10:03:00Z") });
    const found = await r.forAudience({ agent: "canary", memberId: "fixture-owner", address: "slack-user:fixture", door: "slack", accessRevision: 7, since: new Date("2026-09-18T09:00:00Z") });
    expect(found.map(entry => entry.turnId)).toEqual(["t1", "proactive-1", "proactive-2", "proactive-3"]);
    expect(await r.forAudience({ agent: "canary", memberId: "fixture-owner", address: "slack-user:fixture", door: "slack", accessRevision: 8, since: new Date("2026-09-18T09:00:00Z") })).toEqual([]);
  });

  it("keeps a captured approval card only while its exact request remains pending", async () => {
    await pool.query(`INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash)
      VALUES ('approval-pending','call-pending','canary','calendar.create_event','hash-pending'),
             ('approval-settled','call-settled','canary','gmail_send','hash-settled')`);
    const r = makeConversationRecord(pool);
    const audience = { audienceMemberId: "fixture-owner", audienceAddress: "slack-user:fixture", audienceAccessRevision: 7 };
    await r.append({ ...base, ...audience, origin: "third_party", turnId: "pending-card", input: "", reply: "Create the event?\nChoices: Approve / Cancel", proposals: ["calendar.create_event"], approvalRequestId: "approval-pending" });
    await r.append({ ...base, ...audience, origin: "third_party", turnId: "settled-card", input: "", reply: "Send the reply?", proposals: ["gmail_send"], approvalRequestId: "approval-settled" });
    await pool.query("UPDATE approval_asks SET answered_at=now(), outcome='cancelled' WHERE request_id='approval-settled'");
    const found = await r.forAudience({ agent: "canary", memberId: "fixture-owner", address: "slack-user:fixture", door: "slack", accessRevision: 7, since: new Date("2026-09-18T09:00:00Z") });
    expect(found.map(row => row.approvalRequestId)).toEqual(["approval-pending"]);
    expect(found[0]?.origin).toBe("third_party");
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
