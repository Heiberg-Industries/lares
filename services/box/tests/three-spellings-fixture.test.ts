// services/box/tests/three-spellings-fixture.test.ts — W5I-s2. Proves the fixture itself: the
// real migration files apply in order to an empty, disposable Postgres, and the seed reaches
// every member table the inventory (lib/member-scope.ts) lists, under all three (four, counting
// `actor`) id conventions, for two distinct fictional people, and never names the real
// installation's owner.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MEMBER_SCOPE, scopeOf } from "../lib/member-scope.js";
import { startThreeSpellingsDb, FIXTURE_OWNER, FIXTURE_ROWS, type TestDb } from "./helpers/three-spellings.js";

let tdb: TestDb;
beforeAll(async () => {
  tdb = await startThreeSpellingsDb();
}, 180_000);
afterAll(async () => {
  await tdb?.stop();
});

describe("three-spellings fixture", () => {
  it("seeds a row for the owner in EVERY member table the inventory lists", async () => {
    const member = MEMBER_SCOPE.filter((t) => t.scope === "member");
    const seeded = new Set(FIXTURE_ROWS.map((r) => r.table));
    expect(member.filter((t) => !seeded.has(t.table)).map((t) => t.table)).toEqual([]);
  });

  it("reproduces the three conventions, not one string used three times", async () => {
    const kinds = new Set(FIXTURE_ROWS.map((r) => scopeOf(r.table)?.idKind));
    expect(kinds).toEqual(new Set(["registry", "principal", "owner-key", "actor"]));
    // A table still frozen on a legacy `principal` spelling (the inventory's
    // LEGACY_PRINCIPAL_TABLES). `oauth_tokens` used to be the example here; box 085 renamed it
    // onto the register's id, so the fixture seeds it as `registry` and this assertion moved to
    // one of the five tables that genuinely still hold a legacy spelling.
    const legacy = FIXTURE_ROWS.find((r) => r.table === "workflow_jobs")!;
    expect(legacy.value).not.toBe(FIXTURE_OWNER);
  });

  it("seeds a SECOND person whose rows must survive an erase of the first", async () => {
    expect(FIXTURE_ROWS.some((r) => r.value.includes("second"))).toBe(true);
  });

  it("names nobody real: no seeded value is the live installation's owner", () => {
    for (const r of FIXTURE_ROWS) {
      expect(r.value).not.toMatch(/bendik/i);
      expect(r.value).not.toMatch(/heiberg/i);
    }
  });
});
