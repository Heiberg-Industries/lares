// LAR-83: a test that starts a throwaway Postgres must not let the container's shutdown (FATAL
// 57P01 on every open session) surface as an unhandled error that fails an otherwise green run.
// Every such file has to build its pool through tests/helpers/quiet-pool.ts or register the
// "error" listeners itself.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const testsDir = import.meta.dirname;
const files = readdirSync(testsDir, { recursive: true, encoding: "utf8" })
  .map((f) => join(testsDir, f))
  .filter((f) => /\.ts$/.test(f) && !f.endsWith("quiet-pool.ts") && !f.endsWith("quiet-pool-guard.test.ts"));

describe("tests that start a database container quiet their pools", () => {
  it("finds the test files it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every file with a PostgreSqlContainer uses quiet()/quietPool() or registers its own error listeners", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!/PostgreSqlContainer\s*\(/.test(src)) return false;
      const quieted = /\bquiet(Pool)?\(/.test(src) && /quiet-pool(\.js)?["']/.test(src);
      const inline = /\.on\(\s*["']error["']/.test(src) && /\.on\(\s*["']connect["']/.test(src);
      return !quieted && !inline;
    });
    expect(offenders.map((f) => f.slice(testsDir.length + 1))).toEqual([]);
  });
});
