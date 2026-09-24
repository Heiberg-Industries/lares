// services/box/tests/first-owner.test.ts — W8C-s7: the owner becomes a real member, with a real
// id. A REAL disposable Postgres, every migration applied by the runner (a fresh install, not the
// three-spellings fixture), because the point is what a brand-new database looks like.
//
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runMigrations } from "../lib/migration-runner.js";
import { ensureLedger } from "../lib/migration-ledger.js";
import { createFirstOwner, isUntouchedEngineSeed, readEngineSeed } from "../lib/first-owner.js";
import { resolvePerson } from "../lib/person-identity.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
let container: StartedPostgreSqlContainer, pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await ensureLedger(pool);
  await runMigrations(pool, sqlDir);
}, 300_000);
afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("the first owner of a fresh installation", () => {
  it("starts without an assumed owner, alias, organisation or policy", async () => {
    expect(readEngineSeed(sqlDir)).toBeNull();
    for (const table of ["users", "user_aliases", "orgs", "org_member_policy"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect(await isUntouchedEngineSeed(pool)).toBe(false);
  });

  it("creates only the explicitly supplied first owner", async () => {
    const outcome = await createFirstOwner(pool, {
      id: "fixture-owner",
      displayName: "A Name",
      email: "owner@example.invalid",
    });
    expect(outcome).toMatchObject({ kind: "created", id: "fixture-owner", removedEngineSeed: false });
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users");
    expect(rows.map((r) => r.id)).toEqual(["fixture-owner"]);
  });

  it("leaves the owner reachable by their address, not only by their id", async () => {
    const person = await resolvePerson(pool, "owner@example.invalid");
    expect(person.id).toBe("fixture-owner");
  });

  it("is safe to run again, and says nothing was needed", async () => {
    const again = await createFirstOwner(pool, {
      id: "fixture-owner",
      displayName: "A Name",
      email: "owner@example.invalid",
    });
    expect(again).toEqual({ kind: "already", id: "fixture-owner" });
  });

  it("refuses to touch a register that already has somebody else's data in it", async () => {
    await pool.query("INSERT INTO users (id, display_name) VALUES ('fixture-second','Second')");
    await pool
      .query("INSERT INTO reminders (owner, text, due_at) VALUES ('fixture-second','x', now())")
      .catch(() =>
        pool
          .query("INSERT INTO standing_facts (user_id, text) VALUES ('fixture-second','x')")
          .catch(() => {}),
      );
    const outcome = await createFirstOwner(pool, {
      id: "fixture-third",
      displayName: "T",
      email: "t@example.invalid",
    });
    expect(outcome.kind).toBe("refused");
    expect((outcome as { why: string }).why).toMatch(/already has/i);
    await pool.query("DELETE FROM users WHERE id = 'fixture-second'");
  });

  it("refuses a blank id rather than inventing one", async () => {
    const outcome = await createFirstOwner(pool, { id: "   ", displayName: "x", email: "x@example.invalid" });
    expect(outcome.kind).toBe("refused");
  });

  // The register's values reach Postgres inside one multi-statement query, escaped by hand
  // (lib/first-owner.ts's `literal`, the same escape lib/migration-runner.ts uses) because a
  // multi-statement simple query cannot bind parameters. A person's own name is the value most
  // likely to carry a quote, and this is the one table where a mangled or truncated value would
  // be silent and permanent — so it is proven, not assumed. Runs last: it empties the register.
  it("stores a name and an address exactly as given, quotes, backslashes and all", async () => {
    await pool.query("DELETE FROM users");
    const displayName = `O'Brien \\ "quoted"; DROP TABLE users;--`;
    const email = `o'brien+odd@example.invalid`;
    const outcome = await createFirstOwner(pool, { id: "fixture-hostile", displayName, email });
    expect(outcome).toMatchObject({ kind: "created", id: "fixture-hostile" });

    const { rows } = await pool.query<{ display_name: string; primary_email: string }>(
      "SELECT display_name, primary_email FROM users WHERE id = $1",
      ["fixture-hostile"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.display_name).toBe(displayName);
    expect(rows[0]!.primary_email).toBe(email);

    // The alias is written from the same string, and the person is reachable by it.
    const person = await resolvePerson(pool, email);
    expect(person.id).toBe("fixture-hostile");
  });
});
