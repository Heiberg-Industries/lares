import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { auditor, writeAudit } from "../lib/audit.js";
import { readSetting, writeSetting } from "../lib/settings.js";
import { registerAction, resetActions, runAction } from "../lib/actions.js";
import { z } from "zod";
let container: StartedPostgreSqlContainer;
let pool: Pool;
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const sql = readFileSync(new URL("../../box/sql/040_keeper.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});
it("inserts refusals and finalizes a durable pending row exactly once", async () => {
  const operationId = randomUUID();
  const base = { operationId, actor: "owner@example.com", action: "test", input: { value: "<redacted>" } };
  await writeAudit(pool, { ...base, outcome: "pending" });
  expect((await pool.query("SELECT outcome, completed_at FROM keeper_audit WHERE operation_id=$1", [operationId])).rows).toEqual([{ outcome: "pending", completed_at: null }]);
  await writeAudit(pool, { ...base, outcome: "ok" });
  await expect(writeAudit(pool, { ...base, outcome: "failed" })).rejects.toThrow("audit unavailable");
  expect((await pool.query("SELECT outcome FROM keeper_audit WHERE operation_id=$1", [operationId])).rows).toEqual([{ outcome: "ok" }]);
  await writeAudit(pool, { actor: "host", action: "unknown", input: {}, outcome: "refused" });
  expect((await pool.query("SELECT count(*)::int n FROM keeper_audit WHERE action='unknown'")).rows[0].n).toBe(1);
});
it("retains intent when database rejects completion and never reports success", async () => {
  resetActions();
  let calls = 0;
  registerAction({ name: "work", input: z.object({}), run: async () => {
      calls++;
      await pool.query("ALTER TABLE keeper_audit ADD CONSTRAINT test_reject_completion CHECK (action <> 'work' OR outcome='pending')");
      return 1;
    } });
  try {
    await expect(runAction("work", {}, { actor: "host", audit: auditor(pool) })).rejects.toThrow("outcome uncertain");
    expect(calls).toBe(1);
    expect((await pool.query("SELECT outcome FROM keeper_audit WHERE action='work'")).rows).toEqual([{ outcome: "pending" }]);
  }
  finally {
    await pool.query("ALTER TABLE keeper_audit DROP CONSTRAINT test_reject_completion");
    resetActions();
  }
});
it("settings validate, audit old/new once and roll back if the audit insert fails", async () => {
  await expect(writeSetting(pool, "__proto__", {}, "host")).rejects.toThrow("unknown setting");
  await expect(writeSetting(pool, "agents.ceiling", -1, "host")).rejects.toThrow("invalid setting");
  await writeSetting(pool, "agents.ceiling", 0, "host");
  await writeSetting(pool, "agents.ceiling", 2, "host");
  await writeSetting(pool, "agents.ceiling", 2, "host");
  expect(await readSetting(pool, "agents.ceiling")).toBe(2);
  expect((await pool.query("SELECT old_value,new_value FROM settings_audit WHERE key='agents.ceiling' ORDER BY id")).rows).toEqual([{ old_value: null, new_value: 0 }, { old_value: 0, new_value: 2 }]);
  await pool.query("ALTER TABLE settings_audit ADD CONSTRAINT test_reject_setting CHECK (key <> 'house.name')");
  try {
    await expect(writeSetting(pool, "house.name", "Home", "host")).rejects.toThrow("setting write failed");
    expect(await readSetting(pool, "house.name")).toBeUndefined();
  }
  finally {
    await pool.query("ALTER TABLE settings_audit DROP CONSTRAINT test_reject_setting");
  }
});
