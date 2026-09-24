import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KitRatchet, recordApprovalEvent } from "../src/ratchet.js";

const sql = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../services/box/sql", f), "utf8");
let c: StartedPostgreSqlContainer;
let pool: Pool;
beforeAll(async () => {
  c = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: c.getConnectionUri() });
  await pool.query(sql("008_ratchet.sql"));
  await pool.query(sql("038_permissions_board.sql"));
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await c?.stop();
});

describe("the ratchet, for the board", () => {
  it("explicitLevel is null with no row, so the caller can fall back to agent.json", async () => {
    const r = new KitRatchet(pool);
    expect(await r.explicitLevel("calliope", "vault")).toBeNull();
    await r.setLevel("calliope", "vault", "autonomous", undefined, "bendik@example.com");
    expect(await r.explicitLevel("calliope", "vault")).toBe("autonomous");
    expect(await r.level("calliope", "vault")).toBe("autonomous"); // the existing method is unchanged
  });

  it("every change is audited by the trigger — including a writer that forgot to", async () => {
    const r = new KitRatchet(pool);
    await r.setLevel("calliope", "studio", "gated", undefined, "console:bendik");
    await r.setLevel("calliope", "studio", "autonomous", undefined, "console:bendik");
    await r.setLevel("calliope", "studio", "autonomous", undefined, "console:bendik"); // no change → no row
    await pool.query("UPDATE ratchet SET level = 'never', updated_by = 'hand' WHERE agent = 'calliope' AND capability = 'studio'");
    const { rows } = await pool.query(
      "SELECT old_level, new_level, changed_by FROM ratchet_audit WHERE agent = 'calliope' AND capability = 'studio' ORDER BY id",
    );
    expect(rows).toEqual([
      { old_level: null, new_level: "gated", changed_by: "console:bendik" },
      { old_level: "gated", new_level: "autonomous", changed_by: "console:bendik" },
      { old_level: "autonomous", new_level: "never", changed_by: "hand" },
    ]);
  });

  it("deletes audit the actor who deleted — lares.actor when set, unknown otherwise", async () => {
    const r = new KitRatchet(pool);
    // Insert a row with a dedicated client and delete it with lares.actor set
    const client = new Pool({ connectionString: pool.options.connectionString ?? c.getConnectionUri() });
    try {
      await client.query("INSERT INTO ratchet (agent, capability, action, level, updated_by) VALUES ($1, $2, $3, $4, $5)",
        ["deleter", "track", "", "autonomous", "setup"]);
      await client.query("SET lares.actor = 'bendik@example.com (reconciliation)'");
      await client.query("DELETE FROM ratchet WHERE agent = $1 AND capability = $2",
        ["deleter", "track"]);
    } finally {
      await client.end();
    }

    // Delete another row through a fresh client without setting lares.actor
    await r.setLevel("deleter", "report", "gated", undefined, "setup");
    const client2 = new Pool({ connectionString: pool.options.connectionString ?? c.getConnectionUri() });
    try {
      await client2.query("DELETE FROM ratchet WHERE agent = $1 AND capability = $2",
        ["deleter", "report"]);
    } finally {
      await client2.end();
    }

    // Assert both deletes are audited
    const { rows } = await pool.query(
      "SELECT old_level, new_level, changed_by FROM ratchet_audit WHERE agent = 'deleter' AND new_level IS NULL ORDER BY id",
    );
    expect(rows).toEqual([
      { old_level: "autonomous", new_level: null, changed_by: "bendik@example.com (reconciliation)" },
      { old_level: "gated", new_level: null, changed_by: "unknown" },
    ]);
  });

  // Final review F9: a set-then-cleared actor reads back as '' — that must say 'unknown', not ''.
  it("a delete after lares.actor was set and then reset audits 'unknown'", async () => {
    const r = new KitRatchet(pool);
    await r.setLevel("deleter", "cleared", "gated", undefined, "setup");
    const client = await pool.connect();
    try {
      await client.query("SET lares.actor = 'someone@example.com'");
      await client.query("RESET lares.actor");
      await client.query("DELETE FROM ratchet WHERE agent = $1 AND capability = $2", ["deleter", "cleared"]);
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      "SELECT changed_by FROM ratchet_audit WHERE agent = 'deleter' AND capability = 'cleared' AND new_level IS NULL",
    );
    expect(rows).toEqual([{ changed_by: "unknown" }]);
  });

  it("records approval decisions and never throws, even when the table is gone", async () => {
    await recordApprovalEvent(pool, { agent: "saga", capability: "gmail", tool: "gmail_send", decision: "locked", reason: "first contact" });
    const { rows } = await pool.query("SELECT decision, reason FROM approval_events");
    expect(rows).toEqual([{ decision: "locked", reason: "first contact" }]);
    const broken = new Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 200 });
    await expect(recordApprovalEvent(broken, { agent: "a", capability: "b", tool: "c", decision: "asked" })).resolves.toBeUndefined();
    await broken.end();
  });

  // Final review F6: eve re-invokes the policy when an answered card resumes, with the same callId —
  // one card is one piece of evidence. Calls without an id (older paths) are all kept.
  it("one row per callId; rows without a callId are all kept", async () => {
    const e = { agent: "dedupe", capability: "vault", tool: "vault_write", decision: "asked" as const, reason: "set to ask first" };
    await recordApprovalEvent(pool, { ...e, callId: "call-1" });
    await recordApprovalEvent(pool, { ...e, callId: "call-1" });
    await recordApprovalEvent(pool, { ...e, callId: "call-2" });
    await recordApprovalEvent(pool, e);
    await recordApprovalEvent(pool, e);
    const { rows } = await pool.query("SELECT call_id FROM approval_events WHERE agent = 'dedupe' ORDER BY id");
    expect(rows).toEqual([{ call_id: "call-1" }, { call_id: "call-2" }, { call_id: null }, { call_id: null }]);
  });
});
