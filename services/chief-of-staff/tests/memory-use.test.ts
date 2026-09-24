/**
 * W4C-s11 (docs/decisions/0018-learning-and-dreaming.md rule 8) — the usage clock retirement
 * will eventually read. Against a REAL disposable Postgres running the REAL migration file, the
 * house pattern (`tests/agent-notes.test.ts`, `tests/dream-store.test.ts`).
 *
 * This slice does not build retirement, and this file's last case pins that: nothing under
 * `lib/dream/store.js` names stale/archive/retire yet.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";
import { recordUse } from "../lib/dream/store.js";

describe("the usage clock", () => {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    dbUrl = container.getConnectionUri();
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query(readFileSync(join(import.meta.dirname, "../../box/sql/073_memory_use.sql"), "utf8"));
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(async () => {
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query("TRUNCATE memory_use");
  });

  it("records a first use, then counts later ones without losing the first", async () => {
    await recordUse(getPool(), { kind: "standing_fact", refs: ["1", "2"], owner: "fixture-owner" });
    await recordUse(getPool(), { kind: "standing_fact", refs: ["1"], owner: "fixture-owner" });
    const { rows } = await getPool().query(
      "SELECT ref, uses, first_used, last_used FROM memory_use WHERE owner = $1 ORDER BY ref", ["fixture-owner"],
    );
    expect(rows.map((r) => [r.ref, r.uses])).toEqual([["1", 2], ["2", 1]]);
    expect(rows[0]!.last_used.getTime()).toBeGreaterThanOrEqual(rows[0]!.first_used.getTime());
  });

  it("keeps one owner's clock separate from another's", async () => {
    await recordUse(getPool(), { kind: "standing_fact", refs: ["1"], owner: "fixture-owner" });
    await recordUse(getPool(), { kind: "standing_fact", refs: ["1"], owner: "other-owner" });
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM memory_use WHERE ref = '1'");
    expect(rows[0]!.n).toBe(2);
  });

  it("does nothing, and throws nothing, for an empty list", async () => {
    await expect(recordUse(getPool(), { kind: "preference", refs: [], owner: "fixture-owner" })).resolves.toBeUndefined();
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM memory_use");
    expect(rows[0]!.n).toBe(0);
  });

  it("swallows a missing table rather than costing the caller anything", async () => {
    await getPool().query("ALTER TABLE memory_use RENAME TO memory_use_hidden");
    await expect(recordUse(getPool(), { kind: "standing_fact", refs: ["1"], owner: "fixture-owner" }))
      .resolves.toBeUndefined();
    await getPool().query("ALTER TABLE memory_use_hidden RENAME TO memory_use");
  });

  it("nothing reads it yet — retirement is a later wave, and this slice does not start it", async () => {
    const mod = await import("../lib/dream/store.js");
    expect(Object.keys(mod).filter((k) => /stale|archive|retire/i.test(k))).toEqual([]);
  });
});
