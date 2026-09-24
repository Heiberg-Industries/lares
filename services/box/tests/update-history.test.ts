import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { beginUpdate, finishUpdate, previousImages, recentUpdates, UPDATE_HISTORY_KEEP } from "../lib/update-history.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
let container: StartedPostgreSqlContainer, pool: Pool;
const digest = (n: string) => `ghcr.io/example/${n}@sha256:${"b".repeat(64)}`;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  // A stopped container's FATAL 57P01 must not fail an otherwise-green run (the fix
  // startThreeSpellingsDb carries, tests/helpers/three-spellings.ts) — every new testcontainers
  // pool registers both listeners.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => client.on("error", () => undefined));
  await pool.query(readFileSync(join(sqlDir, "087_update_history.sql"), "utf8"));
}, 180_000);
afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("what was running before an update", () => {
  it("is written down before the update starts, and closed when it ends", async () => {
    const id = await beginUpdate(pool, {
      fromRelease: "2026-09-01", toRelease: "2026-10-01",
      images: { console: digest("console") }, snapshotId: "deadbeef",
    });
    let rows = await recentUpdates(pool);
    expect(rows[0]!.outcome).toBe("started");
    expect(rows[0]!.images.console).toBe(digest("console"));
    expect(rows[0]!.snapshotId).toBe("deadbeef");
    await finishUpdate(pool, id, "ok");
    rows = await recentUpdates(pool);
    expect(rows[0]!.outcome).toBe("ok");
  });

  it("hands back the digests that were running before the last good update", async () => {
    expect((await previousImages(pool))!.console).toBe(digest("console"));
  });

  it("answers nothing, rather than guessing, when no update has ever finished", async () => {
    await pool.query("DELETE FROM update_history");
    expect(await previousImages(pool)).toBeNull();
  });

  it("refuses an image that is not a digest, at the database", async () => {
    await expect(beginUpdate(pool, {
      fromRelease: null, toRelease: "x", images: { console: "ghcr.io/example/console:latest" }, snapshotId: null,
    })).rejects.toThrow();
  });

  it("refuses an outcome it does not know", async () => {
    const id = await beginUpdate(pool, { fromRelease: null, toRelease: "y", images: { console: digest("console") }, snapshotId: null });
    await expect(finishUpdate(pool, id, "exploded" as never)).rejects.toThrow();
  });

  it("keeps a bounded history, newest first", async () => {
    for (let i = 0; i < UPDATE_HISTORY_KEEP + 3; i++) {
      const id = await beginUpdate(pool, { fromRelease: null, toRelease: `r${i}`, images: { console: digest("console") }, snapshotId: null });
      await finishUpdate(pool, id, "ok");
    }
    const rows = await recentUpdates(pool);
    expect(rows.length).toBeLessThanOrEqual(UPDATE_HISTORY_KEEP);
    expect(rows[0]!.toRelease).toBe(`r${UPDATE_HISTORY_KEEP + 2}`);
  });
});
