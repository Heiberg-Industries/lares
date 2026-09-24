import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSnapshot } from "../lib/snapshot.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it("copies a WAL-mode db (with sidecars) and opens the copy read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-test-"));
  dirs.push(dir);
  const src = join(dir, "source.db");
  const db = new Database(src);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES ('hello')").run();
  // leave WAL un-checkpointed so the -wal sidecar matters, keep db open like Messages.app
  const result = withSnapshot(src, (snap) => {
    expect(snap.prepare("SELECT v FROM t").get()).toEqual({ v: "hello" });
    expect(() => snap.prepare("INSERT INTO t VALUES ('nope')").run()).toThrow();
    return "ok";
  });
  expect(result).toBe("ok");
  db.close();
});

it("throws a readable error when the source is missing", () => {
  expect(() => withSnapshot("/nonexistent/foo.db", () => null)).toThrow(/not found|no such/i);
});
