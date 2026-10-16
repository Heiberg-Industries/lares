import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolFromEnv, readDatabasePassword } from "../lib/db.js";

// Every case injects both paths. Reading the real /run/secrets/db_password would make the
// result depend on whether the machine running the tests happens to be the older installation.
const NOWHERE = { primaryDefault: "/nonexistent/database-password", legacy: "/nonexistent/db_password" };

describe("the database password's one name", () => {
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

  it("falls back to the old underscore spelling for the one older installation", () => {
    const { "db_password": legacy } = withFiles({ db_password: "older-installation-fixture\n" });
    expect(readDatabasePassword({} as NodeJS.ProcessEnv, { ...NOWHERE, legacy })).toBe(
      "older-installation-fixture",
    );
  });

  it("prefers the new name when both files exist — the fallback never wins a contest", () => {
    const files = withFiles({ "database-password": "the-new-name\n", db_password: "the-old-name\n" });
    expect(
      readDatabasePassword({} as NodeJS.ProcessEnv, {
        primaryDefault: files["database-password"],
        legacy: files["db_password"],
      }),
    ).toBe("the-new-name");
  });

  it("treats a blank file as absent, so an empty secret never becomes an empty password", () => {
    const files = withFiles({ "database-password": "   \n", db_password: "older-installation-fixture\n" });
    expect(
      readDatabasePassword({} as NodeJS.ProcessEnv, {
        primaryDefault: files["database-password"],
        legacy: files["db_password"],
      }),
    ).toBe("older-installation-fixture");
  });

  it("falls back to PGPASSWORD when neither file is there, and to nothing when it is blank", () => {
    expect(readDatabasePassword({ PGPASSWORD: "disposable-fixture-only" } as NodeJS.ProcessEnv, NOWHERE)).toBe(
      "disposable-fixture-only",
    );
    expect(readDatabasePassword({ PGPASSWORD: "  " } as NodeJS.ProcessEnv, NOWHERE)).toBeUndefined();
    expect(readDatabasePassword({} as NodeJS.ProcessEnv, NOWHERE)).toBeUndefined();
  });

  it("poolFromEnv takes its host, user and database from the env it is given", () => {
    const pool = poolFromEnv({}, { PGHOST: "db", PGUSER: "fixture-user", PGDATABASE: "fixture_db" } as NodeJS.ProcessEnv);
    const options = pool.options as { host?: string; user?: string; database?: string };
    expect(options.host).toBe("db");
    expect(options.user).toBe("fixture-user");
    expect(options.database).toBe("fixture_db");
    void pool.end();
  });
});
