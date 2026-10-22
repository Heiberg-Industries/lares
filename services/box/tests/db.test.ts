import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolFromEnv, readDatabasePassword } from "../lib/db.js";

// Every case injects the path so a test never depends on a live secret file.
const NOWHERE = { primaryDefault: "/nonexistent/database-password" };

describe("the app database password file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const withFiles = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "db-secret-"));
    dirs.push(dir);
    const paths: Record<string, string> = {};
    for (const [name, body] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], body);
    }
    return paths;
  };

  it("reads DATABASE_PASSWORD_FILE, the same name every agent and start.sh already use", () => {
    const { "database-password": file } = withFiles({ "database-password": "disposable-fixture-only\n" });
    expect(readDatabasePassword({ DATABASE_PASSWORD_FILE: file } as NodeJS.ProcessEnv, NOWHERE)).toBe(
      "disposable-fixture-only",
    );
  });

  it("does not adopt the old underscore spelling or PGPASSWORD as app authority", () => {
    withFiles({ db_password: "old-fixture-only" });
    expect(readDatabasePassword({} as NodeJS.ProcessEnv, NOWHERE)).toBeUndefined();
    expect(readDatabasePassword({ PGPASSWORD: "disposable-fixture-only" } as NodeJS.ProcessEnv, NOWHERE)).toBe(
      undefined,
    );
    expect(readDatabasePassword({} as NodeJS.ProcessEnv, NOWHERE)).toBeUndefined();
  });

  it("poolFromEnv takes its host, user and database from the env it is given", () => {
    const { "database-password": passwordFile } = withFiles({ "database-password": "disposable-fixture-only" });
    const pool = poolFromEnv({}, { PGHOST: "db", PGUSER: "fixture-user", PGDATABASE: "fixture_db", DATABASE_PASSWORD_FILE: passwordFile } as NodeJS.ProcessEnv);
    const options = pool.options as { host?: string; user?: string; database?: string };
    expect(options.host).toBe("db");
    expect(options.user).toBe("fixture-user");
    expect(options.database).toBe("fixture_db");
    void pool.end();
  });

  it("defaults application pools to the limited app role", () => {
    const { "database-password": passwordFile } = withFiles({ "database-password": "disposable-fixture-only" });
    const pool = poolFromEnv({}, { DATABASE_PASSWORD_FILE: passwordFile } as NodeJS.ProcessEnv);
    expect((pool.options as { user?: string }).user).toBe("lares_app");
    void pool.end();
  });

  it("refuses to build an application pool without its explicit password file", () => {
    expect(() => poolFromEnv({}, { PGPASSWORD: "must-not-be-authority" } as NodeJS.ProcessEnv)).toThrow("application database password file is missing or blank");
  });
});
