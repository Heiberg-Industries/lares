/** Owner identity is read at operation time from explicit configuration or the
 * identity register. Missing identity and ambiguous registers must refuse. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

import { getPool, closePool } from "@lares/agent-kit/db";
import { openRepairs } from "@lares/agent-kit/repairs";
import {
  configuredOwnerId,
  canonicalUserId,
  checkOwnerKeyAgreement,
  ownerIdFromEnvOrConstant,
  resetOwnerKeyCheckForTests,
  SeveralPeopleOnThisInstallation,
} from "../lib/identity-client.js";
import { ownerId } from "../lib/principals.js";

describe("one owner key, not two that agree by luck", () => {
  it("the constant and the env-driven owner can never disagree", () => {
    expect(() => ownerId({})).toThrow("Owner identity is not configured");
    expect(() => configuredOwnerId({ AGENT_OWNER_USER_ID: "  " })).toThrow("Owner identity is not configured");
  });

  it("a configured owner is used by BOTH, or neither", () => {
    const env = { AGENT_OWNER_USER_ID: "someone-else" };
    expect(ownerId(env)).toBe("someone-else");
    // Before this slice, `CANONICAL_USER_ID` stayed at its compiled literal here — 207 call
    // sites would go on writing the wrong key even though a configured owner was in effect.
    expect(ownerIdFromEnvOrConstant(env)).toBe("someone-else");
  });

  describe("against a real, disposable register", () => {
    let container: StartedPostgreSqlContainer;
    let dbUrl: string;
    let pool: Pool;

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      dbUrl = container.getConnectionUri();
      process.env["DATABASE_URL"] = dbUrl;
      pool = getPool();
      // The identity register's real shape (services/box/sql/014_identity.sql), WITHOUT its
      // seed data — a test asserts on a fixture id, never the real installation's row
      // (BUILDER.md: "a test that needs an owner id uses 'fixture-owner'").
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            text        PRIMARY KEY,
          display_name  text        NOT NULL,
          primary_email text,
          created_at    timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS fixture_rows (owner text NOT NULL, note text NOT NULL);
      `);
      // repairs (services/box/sql/079_repairs.sql) is self-contained and hand-applied with no
      // seed data, unlike identity's own file above — so unlike `users`, it is read for real
      // rather than mirrored, the same way `packages/agent-kit/tests/repairs.test.ts` does.
      await pool.query(readFileSync(join(import.meta.dirname, "..", "..", "box", "sql", "079_repairs.sql"), "utf8"));
    }, 120_000);

    afterAll(async () => {
      await closePool();
      await container.stop();
    });

    beforeEach(async () => {
      process.env["DATABASE_URL"] = dbUrl;
      await pool.query("TRUNCATE users, fixture_rows, repairs");
      await pool.query("INSERT INTO users (id, display_name) VALUES ('fixture-owner', 'Fixture Owner')");
      resetOwnerKeyCheckForTests();
    });

    it("reads the register when it can, and refuses to pick a winner when it cannot", async () => {
      expect(await canonicalUserId(pool)).toBe("fixture-owner");
      await pool.query("INSERT INTO users (id, display_name) VALUES ('fixture-second','Second')");
      await expect(canonicalUserId(pool)).rejects.toThrow(SeveralPeopleOnThisInstallation);
    });

    it("on the one-member shape, a row already written under the configured owner id is still found by the register's id", async () => {
      // The real installation's shape: the register's single row IS the configured/constant
      // owner id. Reproduced here with the fixture id rather than the real one.
      const configured = ownerIdFromEnvOrConstant({ AGENT_OWNER_USER_ID: "fixture-owner" });
      await pool.query("INSERT INTO fixture_rows (owner, note) VALUES ($1, 'written before this slice')", [
        configured,
      ]);

      const registerId = await canonicalUserId(pool);
      expect(registerId).toBe(configured);

      const { rows } = await pool.query<{ note: string }>("SELECT note FROM fixture_rows WHERE owner = $1", [
        registerId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.note).toBe("written before this slice");
    });

    // ── W5I-s5b: the configured key and the register are checked against each other ─────────
    describe("checkOwnerKeyAgreement", () => {
      const env = { AGENT_OWNER_USER_ID: "fixture-owner" };

      it("agree: the register's one member matches the configured key — nothing logged, nothing opened", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(await checkOwnerKeyAgreement(pool, env)).toBe("agree");
          expect(error).not.toHaveBeenCalled();
          expect(await openRepairs(pool)).toEqual([]);
        } finally {
          error.mockRestore();
        }
      });

      it("disagree: one error line across two calls, one repair opened with exactly the fixed sentences", async () => {
        const disagreeing = { AGENT_OWNER_USER_ID: "someone-else" };
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(await checkOwnerKeyAgreement(pool, disagreeing)).toBe("disagree");
          expect(await checkOwnerKeyAgreement(pool, disagreeing)).toBe("disagree");
          expect(error).toHaveBeenCalledTimes(1);

          const open = await openRepairs(pool);
          expect(open).toHaveLength(1);
          expect(open[0]).toMatchObject({
            kind: "identity",
            ref: "owner-key",
            severity: "error",
            what: "The owner id this agent is configured with and the one in the identity register differ, so memory is being filed under a name that forget, export and erase will not look under.",
            howToFix: "Set AGENT_OWNER_USER_ID to the register's id, or correct the register, then restart.",
          });
        } finally {
          error.mockRestore();
        }
      });

      it("disagree, then agree: the repair opened for the disagreement is resolved", async () => {
        const disagreeing = { AGENT_OWNER_USER_ID: "someone-else" };
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(await checkOwnerKeyAgreement(pool, disagreeing)).toBe("disagree");
          expect(await openRepairs(pool)).toHaveLength(1);

          expect(await checkOwnerKeyAgreement(pool, env)).toBe("agree");
          expect(await openRepairs(pool)).toEqual([]);
        } finally {
          error.mockRestore();
        }
      });

      it("several-members: silent — the known, written-down multi-user gap, not this slice's defect", async () => {
        await pool.query("INSERT INTO users (id, display_name) VALUES ('fixture-second', 'Second')");
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(await checkOwnerKeyAgreement(pool, { AGENT_OWNER_USER_ID: "someone-else" })).toBe(
            "several-members",
          );
          expect(error).not.toHaveBeenCalled();
          expect(await openRepairs(pool)).toEqual([]);
        } finally {
          error.mockRestore();
        }
      });

      it("register-unreadable: silent, and never throws — a zero-row register or a broken query is already reported elsewhere", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await pool.query("TRUNCATE users");
          await expect(checkOwnerKeyAgreement(pool, env)).resolves.toBe("register-unreadable");

          const unreachablePool = { query: () => Promise.reject(new Error("connection refused")) } as unknown as Pool;
          await expect(checkOwnerKeyAgreement(unreachablePool, env)).resolves.toBe("register-unreadable");

          expect(error).not.toHaveBeenCalled();
          expect(await openRepairs(pool)).toEqual([]);
        } finally {
          error.mockRestore();
        }
      });
    });
  });

  it("no writer under lib/ or agent/ names the owner with a personal literal", () => {
    const offenders = grepSources(
      ["services/chief-of-staff/lib", "services/chief-of-staff/agent"],
      /["']bendik["']/,
      { exclude: [] },
    );
    expect(offenders).toEqual([]);
  });

  it("the owner helper contains no personal fallback", () => {
    const codeLines = readFileSync(join(import.meta.dirname, "..", "lib", "principals.ts"), "utf8")
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t === "");
      });
    const matches = codeLines.flatMap((line) => line.match(/["']bendik["']/g) ?? []);
    expect(matches).toEqual([]);
  });
});

/**
 * Every `.ts` file (excluding tests) under `roots` (repo-relative) with a CODE line (not a
 * comment) matching `pattern`, except the explicitly named exceptions — read as TEXT, no
 * runtime, the same technique `tests/no-tool-takes-an-origin.test.ts` uses so a re-export
 * cannot hide a match.
 *
 * Comment lines are skipped on purpose: several files under `lib/` carry prose that quotes
 * the literal to explain why it is NOT used there (`google.ts`, `reminders-store.ts`,
 * `slack-source.ts`, `turn-capture.ts` — none of them assign or default to it). A plain
 * text match without this filter flags that prose as if it were a fifth writer, which is not
 * the defect this guard exists to catch — "a writer names the owner with a literal string".
 */
function grepSources(roots: string[], pattern: RegExp, opts: { exclude?: string[] } = {}): string[] {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const exclude = new Set((opts.exclude ?? []).map((p) => join("services", "chief-of-staff", p)));
  const offenders: string[] = [];
  for (const root of roots) {
    walk(join(repoRoot, root), (file) => {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) return;
      const rel = file.slice(repoRoot.length + 1);
      if (exclude.has(rel)) return;
      const codeLines = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t === "");
        });
      if (codeLines.some((line) => pattern.test(line))) offenders.push(rel);
    });
  }
  return offenders;
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}
