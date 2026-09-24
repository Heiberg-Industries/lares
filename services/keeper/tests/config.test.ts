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
it("rejects incomplete, invalid and secret-bearing configs without echoing input", () => {
  const f = fixture();
  for (const config of [{ ...f.config, project: "secret;rm" }, { ...f.config, db: { ...f.config.db, password: "secret" } }, { ...f.config, agentsDir: "relative" }]) {
    writeFileSync(f.file, JSON.stringify(config));
    expect(() => loadKeeperConfig(f.file)).toThrow("invalid or unreadable configuration");
  }
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
