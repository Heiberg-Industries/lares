import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { keeperPool, loadKeeperConfig } from "../lib/config.js";
const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-config-"));
  dirs.push(dir);
  return { dir, file: join(dir, "keeper.json"), config: { mode: "overlay", project: "lares", dir, files: ["compose.yaml"], agentsDir: dir, retiredDir: dir, secretsDir: dir, rolesDir: dir, templatesDir: dir, backupDir: dir, db: { host: "db", port: 5432, database: "lares_state", user: "lares", passwordFile: join(dir, "password") } } };
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("loads overlay and rendered configs without installation defaults", () => {
  const f = fixture();
  for (const mode of ["overlay", "rendered"]) {
    writeFileSync(f.file, JSON.stringify({ ...f.config, mode }));
    expect(loadKeeperConfig(f.file)).toEqual({ ...f.config, mode });
  }
});
// LAR-89: the keeper used to replace every failure with "invalid or unreadable configuration",
// so the owner could not see which field in the boot file was wrong. Each failure now says
// what it is and where — and still never repeats a value from the file.
it("a missing file is reported as missing, with its path and the system's reason", () => {
  const f = fixture();
  expect(() => loadKeeperConfig(f.file)).toThrow(`keeper: configuration file ${f.file} is missing or unreadable (ENOENT)`);
});
it("a file that is not JSON is reported as such, without quoting its text", () => {
  const f = fixture();
  writeFileSync(f.file, '{ "db": { "password": "hunter2-the-secret" }');
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toBe(`keeper: configuration file ${f.file} is not valid JSON`);
  expect(error.message).not.toContain("hunter2");
});
it("a schema failure names the field's path and the reason, for top-level and nested fields alike", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.config, project: "secret;rm", db: { ...f.config.db, port: "5432" } }));
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toContain(`keeper: invalid configuration in ${f.file}:`);
  expect(error.message).toMatch(/\bproject: /);
  expect(error.message).toMatch(/\bdb\.port: .*expected number/);
  expect(error.message).not.toContain("secret;rm");
  expect(error.message).not.toContain("5432");
});
it("names an unrecognized key but never the value stored under it", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.config, db: { ...f.config.db, password: "hunter2-the-secret" } }));
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toMatch(/\bdb: .*password/);
  expect(error.message).not.toContain("hunter2");
});
it("a relative directory is refused with the field named, not the path echoed", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.config, agentsDir: "relative/agents-of-hunter2" }));
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toMatch(/\bagentsDir: /);
  expect(error.message).not.toContain("hunter2");
});
it("reads the password only when creating a pool", async () => {
  const f = fixture();
  writeFileSync(f.config.db.passwordFile, "secret\n");
  const pool = keeperPool(f.config.db);
  expect(pool.options.password).toBe("secret");
  expect(pool.options.database).toBe("lares_state");
  await pool.end();
  rmSync(f.config.db.passwordFile);
  expect(() => keeperPool(f.config.db)).toThrow("credentials unavailable");
});
function catchError(fn: () => unknown): Error {
  try {
    fn();
  }
  catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw");
}
