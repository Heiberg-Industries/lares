import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readBriefLanguage, isBriefLanguage, BRIEF_LANGUAGES } from "../lib/brief-settings.js";

/**
 * LAR-16-s1 — backs `sql/050_brief_settings.sql` against a REAL Postgres (testcontainers, the
 * ORB-45 pattern): a fake pool that never executes SQL is forbidden here.
 *
 * Owner's amendment (2026-09-18): the supported set is English plus the four Nordic languages,
 * not just "nb"/"en", and the SQL CHECK is a two-letter FORMAT only — never an enumerated list —
 * so a language can be added later without a migration.
 */
const migration = readFileSync(join(import.meta.dirname, "../../box/sql/050_brief_settings.sql"), "utf8");

describe("050_brief_settings.sql / brief-settings", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(migration);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE brief_settings");
  });

  it("applies cleanly twice", async () => {
    await expect(pool.query(migration)).resolves.toBeDefined();
  });

  describe("isBriefLanguage", () => {
    it("recognises exactly the five launch languages", () => {
      expect(BRIEF_LANGUAGES).toEqual(["en", "nb", "sv", "da", "fi"]);
      for (const lang of BRIEF_LANGUAGES) expect(isBriefLanguage(lang)).toBe(true);
      expect(isBriefLanguage("de")).toBe(false);
    });
  });

  describe("readBriefLanguage", () => {
    it('returns "en" when no row exists for the owner', async () => {
      const lang = await readBriefLanguage(pool, "bendik");
      expect(lang).toBe("en");
    });

    it.each(["nb", "sv", "da", "fi"] as const)('reads a stored "%s" row back as itself', async (code) => {
      await pool.query(
        `INSERT INTO brief_settings (owner, language, updated_by) VALUES ($1, $2, 'owner')`,
        ["bendik", code],
      );
      const lang = await readBriefLanguage(pool, "bendik");
      expect(lang).toBe(code);
    });

    it('falls back to "en" with one warning when the stored code is well-formed but not (yet) supported', async () => {
      await pool.query(
        `INSERT INTO brief_settings (owner, language, updated_by) VALUES ($1, 'de', 'owner')`,
        ["bendik"],
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const lang = await readBriefLanguage(pool, "bendik");
        expect(lang).toBe("en");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/"de"/);
      } finally {
        warn.mockRestore();
      }
    });

    it('falls back to "en" with one warning when the query throws', async () => {
      await pool.query("DROP TABLE brief_settings");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const lang = await readBriefLanguage(pool, "bendik");
        expect(lang).toBe("en");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        await pool.query(migration);
      }
    });
  });

  describe("the language CHECK", () => {
    it.each(["EN", "eng", ""])("rejects %j", async (bad) => {
      await expect(
        pool.query(`INSERT INTO brief_settings (owner, language) VALUES ('bendik', $1)`, [bad]),
      ).rejects.toThrow();
    });
  });
});
