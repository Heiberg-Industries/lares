import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openRepair, resolveRepair, openRepairs, resetRepairWarningForTests, REPAIR_TEXT_LIMITS,
} from "../src/repairs.js";

let container: StartedPostgreSqlContainer;
let db: Pool;
const SQL = join(import.meta.dirname, "..", "..", "..", "services/box/sql/079_repairs.sql");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  await db.query(readFileSync(SQL, "utf8"));
}, 120_000);
afterAll(async () => { await db.end(); await container.stop(); });
beforeEach(async () => { await db.query("TRUNCATE repairs"); resetRepairWarningForTests(); });

const dead = {
  kind: "sign-in", ref: "google", severity: "error" as const,
  what: "The Google connection stopped working.",
  howToFix: "Reconnect it on the Connections page.", breaksIn: null,
};

describe("repairs", () => {
  it("opens one row, and a repeat touches it instead of making a second", async () => {
    await openRepair(db, dead);
    const first = (await openRepairs(db))[0]!;
    await openRepair(db, dead);
    const rows = await openRepairs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.openedAt.getTime()).toBe(first.openedAt.getTime());
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  it("closes on recovery, and closing something that is not open does nothing", async () => {
    await resolveRepair(db, "sign-in", "google");
    expect(await openRepairs(db)).toHaveLength(0);
    await openRepair(db, dead);
    await resolveRepair(db, "sign-in", "google");
    expect(await openRepairs(db)).toHaveLength(0);
    const { rows } = await db.query("SELECT resolved_at FROM repairs");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved_at).not.toBeNull();
  });

  it("re-opens the same row when it breaks again, rather than leaving it closed", async () => {
    await openRepair(db, dead);
    await resolveRepair(db, "sign-in", "google");
    await openRepair(db, dead);
    expect(await openRepairs(db)).toHaveLength(1);
  });

  it("refuses an empty sentence — a repair with nothing to read is worse than none", async () => {
    await expect(
      db.query("INSERT INTO repairs (kind, ref, severity, what) VALUES ('x','y','error','  ')"),
    ).rejects.toThrow(/repairs_what_not_empty/);
  });

  it("names the three severities and nothing else", async () => {
    await expect(
      db.query("INSERT INTO repairs (kind, ref, severity, what) VALUES ('x','y','critical','z')"),
    ).rejects.toThrow(/repairs_severity_check/);
  });

  it("lists the worst first — an error before a warning before a note", async () => {
    await openRepair(db, { kind: "sign-in", ref: "a", severity: "info", what: "a note" });
    await openRepair(db, { kind: "sign-in", ref: "b", severity: "error", what: "broken" });
    await openRepair(db, { kind: "sign-in", ref: "c", severity: "warn", what: "wobbly" });
    expect((await openRepairs(db)).map((r) => r.severity)).toEqual(["error", "warn", "info"]);
  });

  it("cuts a dump down to a sentence instead of failing to open the repair", async () => {
    await openRepair(db, { kind: "sign-in", ref: "long", severity: "error", what: "x".repeat(5000) });
    const [row] = await openRepairs(db);
    expect(row?.what.length).toBe(REPAIR_TEXT_LIMITS.what);
    await expect(
      db.query("INSERT INTO repairs (kind, ref, severity, what) VALUES ('k','r2','info',$1)", ["y".repeat(401)]),
    ).rejects.toThrow(/repairs_short_text/);
  });

  it("never throws when the table is missing, and never costs the turn", async () => {
    await db.query("DROP TABLE repairs");
    await expect(openRepair(db, dead)).resolves.toBeUndefined();
    await expect(resolveRepair(db, "sign-in", "google")).resolves.toBeUndefined();
    await expect(openRepairs(db)).resolves.toEqual([]);
    await db.query(readFileSync(SQL, "utf8"));
  });
});
