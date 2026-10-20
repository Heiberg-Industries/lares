import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordModelStep, resetModelUsageWarningForTests } from "../src/model-usage.js";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "box", "sql");

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  db.on("error", () => undefined);
  db.on("connect", (client) => client.on("error", () => undefined));
  await db.query(readFileSync(join(SQL_DIR, "005_model_steps.sql"), "utf8"));
}, 120_000);
afterAll(async () => {
  await db.end();
  await container.stop();
});
beforeEach(async () => {
  await db.query("TRUNCATE model_steps");
  resetModelUsageWarningForTests();
});

const step = (over: Partial<Parameters<typeof recordModelStep>[1]> = {}) => ({
  eventId: "evt-1", agent: "assistant", sessionId: "s1", turnId: "t1", stepIndex: 0,
  inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.0123,
  ...over,
});

describe("recordModelStep", () => {
  it("writes one row with the token counts", async () => {
    await recordModelStep(db, step({ at: "2026-10-01T10:00:00Z" }));
    const { rows } = await db.query("SELECT * FROM model_steps");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: "evt-1", agent: "assistant", session_id: "s1", turn_id: "t1", step_index: 0,
      input_tokens: "1000", output_tokens: "50", cache_read_tokens: "800", cache_write_tokens: "100",
    });
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0123);
    expect(rows[0].at.toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  it("keeps a number the provider did not report as NULL, not zero", async () => {
    await recordModelStep(db, step({ cacheReadTokens: undefined, cacheWriteTokens: undefined, costUsd: undefined }));
    const { rows } = await db.query("SELECT cache_read_tokens, cache_write_tokens, cost_usd FROM model_steps");
    expect(rows[0]).toEqual({ cache_read_tokens: null, cache_write_tokens: null, cost_usd: null });
  });

  it("a repeat of the same event id keeps the first row", async () => {
    await recordModelStep(db, step());
    await recordModelStep(db, step({ inputTokens: 9999 }));
    const { rows } = await db.query("SELECT input_tokens FROM model_steps");
    expect(rows).toEqual([{ input_tokens: "1000" }]);
  });

  it("removes this agent's rows older than 90 days when it inserts, and no other agent's", async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    await db.query(
      `INSERT INTO model_steps (event_id, agent, session_id, turn_id, step_index, at) VALUES
         ('old', 'assistant', 's', 't', 0, $1), ('other-old', 'other', 's', 't', 0, $1)`,
      [daysAgo(91)],
    );
    await recordModelStep(db, step({ eventId: "recent", at: daysAgo(89) }));
    const { rows } = await db.query("SELECT event_id FROM model_steps ORDER BY event_id");
    expect(rows.map((r) => r.event_id)).toEqual(["other-old", "recent"]);
  });

  it("never throws and warns once when the table is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { query: async () => { throw new Error("relation does not exist"); } };
    await expect(recordModelStep(broken as never, step())).resolves.toBeUndefined();
    await expect(recordModelStep(broken as never, step())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
