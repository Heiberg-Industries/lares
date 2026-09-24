import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "../src/db.js";

/**
 * ORB-45 lesson (binding, per the task brief): a fake/mocked `Pool` that never executes
 * real SQL is exactly the "built+tested+non-functional" defect class that has bitten this
 * project before. This proves `getPool()` against a real, disposable Postgres
 * (testcontainers) — not a stub — the same house pattern as
 * `services/box/tests/helpers/pg.ts` and `services/atlas/tests/apply.test.ts`.
 */
describe("getPool", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  it("executes real SQL against a real Postgres", async () => {
    const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    const res = await pool.query("SELECT 1 + 1 AS sum");
    expect(res.rows[0]).toEqual({ sum: 2 });
  });

  it("round-trips a real write through a real table", async () => {
    const pool = getPool();
    await pool.query("CREATE TABLE IF NOT EXISTS db_test_probe (id serial PRIMARY KEY, note text NOT NULL)");
    await pool.query("INSERT INTO db_test_probe (note) VALUES ($1)", ["it actually executed SQL"]);
    const res = await pool.query("SELECT note FROM db_test_probe ORDER BY id DESC LIMIT 1");
    expect(res.rows[0]?.note).toBe("it actually executed SQL");
  });

  it("is a lazy singleton — repeated calls return the same Pool instance", () => {
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });

  it("throws, rather than silently connecting nowhere, when DATABASE_URL is unset", async () => {
    await closePool();
    expect(() => getPool({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
    // Restore the singleton for any tests that run after this one.
    getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
  });

  it("closePool lets a subsequent getPool() build a genuinely fresh Pool", async () => {
    const before = getPool();
    await closePool();
    const after = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    expect(after).not.toBe(before);
    const res = await after.query("SELECT 1 AS ok");
    expect(res.rows[0]).toEqual({ ok: 1 });
  });

  // Regression for the chief-of-staff CI race (LAR-60): a testcontainer stopping out from
  // under an idle client used to surface as an UNCAUGHT exception on the Pool, because
  // node-postgres treats a Pool with no 'error' listener that way. This proves getPool()'s
  // own pool survives an 'error' event instead of throwing, and logs one plain line.
  it("survives an idle client's connection dying instead of throwing, and logs one line", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const current = getPool();
    expect(() => current.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("terminating connection due to administrator command");
    errSpy.mockRestore();
  });
});
