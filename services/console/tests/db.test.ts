import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("pg", () => ({ Pool: class { constructor(_config: unknown) {} } }));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

it("requires the explicit console app password file and ignores ambient PGPASSWORD", async () => {
  const directory = mkdtempSync(join(tmpdir(), "console-db-secret-"));
  dirs.push(directory);
  const passwordFile = join(directory, "database-password");
  writeFileSync(passwordFile, "explicit-app-password\n");
  vi.stubEnv("PGPASSWORD_FILE", passwordFile);
  vi.stubEnv("PGPASSWORD", "must-not-be-authority");
  const { databasePoolConfig } = await import("../lib/db.js");
  expect(() => databasePoolConfig({ PGPASSWORD: "must-not-be-authority" })).toThrow("application database password file is not configured");
  expect(databasePoolConfig({ PGPASSWORD_FILE: passwordFile, PGPASSWORD: "ignored" })).toMatchObject({
    user: "lares_app",
    database: "lares_state",
    password: "explicit-app-password",
  });
});

it("rejects a blank console app password file", async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), "console-db-secret-"));
  dirs.push(directory);
  const passwordFile = join(directory, "database-password");
  writeFileSync(passwordFile, "  \n");
  const { databasePoolConfig } = await import("../lib/db.js");
  expect(() => databasePoolConfig({ PGPASSWORD_FILE: passwordFile, PGPASSWORD: "ignored" })).toThrow("application database password file is blank");
});
