import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../lib/db.js";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "network-test-"));
  dirs.push(dir);
  return join(dir, "network.db");
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("openDb", () => {
  it("creates the schema on first open", () => {
    const db = openDb(tempDbPath());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ["contacts", "identities", "interactions", "positions", "signals", "pulse", "import_runs", "identity_overrides"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("is idempotent (re-open does not fail or wipe)", () => {
    const path = tempDbPath();
    const db1 = openDb(path);
    db1.prepare("INSERT INTO contacts (display_name, source) VALUES ('Test Person', 'test')").run();
    db1.close();
    const db2 = openDb(path);
    expect(db2.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 });
    db2.close();
  });

  it("works with :memory: and has the schema", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ["contacts", "identities", "interactions", "positions", "signals", "pulse", "import_runs", "identity_overrides"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });
});
