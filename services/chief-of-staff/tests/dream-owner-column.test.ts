/**
 * services/chief-of-staff/tests/dream-owner-column.test.ts — W5I-s6 (box 084, ruling D5).
 *
 * Proves three things about the dream tables' new `owner` column:
 *   1. a NEW row written through the store always carries the owner the caller supplied —
 *      `makeDreamStore(db, owner)` binds it once, at construction, so a store built without one
 *      (a read-only caller) throws a loud error rather than writing a silently NULL owner;
 *   2. `ensureDreamTables`'s ALTER never invents an owner for a row that predates the column —
 *      the same rule this service already follows for `origin` (see `tests/dream-store.test.ts`);
 *   3. `labelExistingDreamRows` — the D5 rule as a reusable, idempotent runtime function — labels
 *      pre-existing NULL rows as the installation's one member, and ONLY when there is exactly
 *      one: with no member, or a second one, it leaves every row NULL and says why, and a second
 *      run never relabels a row the first run already decided about.
 *
 * A hand-rolled `users` table, not `services/box/sql/014_identity.sql`: this service does not
 * depend on services/box (`services/box/tests/helpers/three-spellings.ts` is the fixture that
 * copies THIS file's DDL, the other way around — see that file's own header). Shaped just enough
 * to answer "how many members, and who is the one" — `id` and nothing else this file needs.
 *
 * Box `084_dream_tables_owner.sql` runs the identical rule against the live installation's own
 * database (applied by hand, over SSH); its own file explains why this TS function exists
 * alongside it rather than instead of it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { ensureDreamTables, makeDreamStore, labelExistingDreamRows } from "../lib/dream/store.js";
import type { Observation } from "../lib/dream/reflect.js";

const FIXTURE_OWNER = "fixture-owner";
const FIXTURE_SECOND = "fixture-second";

describe("the dream tables' owner column (box 084, ruling D5)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    // Minimal stand-in for services/box/sql/014_identity.sql's `users` table — only the shape
    // `labelExistingDreamRows` reads (id, and enough to count rows).
    await pool.query(`CREATE TABLE users (id text PRIMARY KEY, display_name text NOT NULL)`);
    await ensureDreamTables(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM dream_observations");
    await pool.query("DELETE FROM dream_preferences");
    await pool.query("DELETE FROM users");
  });

  // ── 1. Every NEW row carries the owner ─────────────────────────────────────────────────────

  it("a new observation records whose it is", async () => {
    const store = makeDreamStore(pool, FIXTURE_OWNER);
    const obs: Observation = {
      text: "prefers the train", kind: "identity", subject: "", confidence: 0.4,
      evidenceRefs: [], origin: "owner",
    };
    const row = await store.record(obs, "dream-cycle-test", "owner");
    expect(row.owner).toBe(FIXTURE_OWNER);
  });

  it("a new preference records whose it is", async () => {
    const store = makeDreamStore(pool, FIXTURE_OWNER);
    const pref = await store.addPreference({
      text: "takes the train", kind: "preference", subject: "travel", confidence: 1, origin: "owner",
    });
    expect(pref.owner).toBe(FIXTURE_OWNER);
  });

  it("refuses to write a row through a store that was never given an owner", async () => {
    const store = makeDreamStore(pool); // no second argument — a read-only construction
    const obs: Observation = {
      text: "x", kind: "identity", subject: "", confidence: 0.4, evidenceRefs: [], origin: "owner",
    };
    await expect(store.record(obs, undefined, "owner")).rejects.toThrow(/owner/i);
    await expect(
      store.addPreference({ text: "x", kind: "preference", subject: "", confidence: 0, origin: "owner" }),
    ).rejects.toThrow(/owner/i);
    // And nothing was half-written on the way to the throw.
    expect(await store.activePreferences()).toEqual([]);
  });

  // ── Reads never filter by owner — a NULL-owner row from before the column existed must not
  //    become invisible on a single-member installation (requirement 3). Nothing in this file's
  //    changes touches `activePreferences`'s or `ownerRecurrenceCount`'s WHERE clause, and this
  //    is the test that would catch it if a later edit added one.

  it("a read of active preferences still returns a pre-existing NULL-owner row", async () => {
    await pool.query(
      `INSERT INTO dream_preferences (text, kind, subject, confidence, origin)
       VALUES ('an old preference', 'preference', '', 1, 'owner')`,
    );
    const store = makeDreamStore(pool, FIXTURE_OWNER);
    const active = await store.activePreferences();
    const old = active.find((p) => p.text === "an old preference");
    expect(old).toBeDefined();
    expect(old!.owner).toBeNull();
  });

  // ── 2. The ALTER never invents an owner ────────────────────────────────────────────────────

  it("adding the column alone never invents an owner", async () => {
    await pool.query("DROP TABLE IF EXISTS dream_observations");
    await pool.query(
      "CREATE TABLE dream_observations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), text text NOT NULL, kind text NOT NULL)",
    );
    await pool.query("INSERT INTO dream_observations (text, kind) VALUES ('old','identity')");
    await ensureDreamTables(pool); // the ALTER only — no labelling
    const { rows } = await pool.query("SELECT owner FROM dream_observations WHERE text = 'old'");
    expect(rows[0].owner).toBeNull();
  });

  // ── 3. Ruling D5: label the old rows when, and only when, there is exactly one member ─────

  it("labels the existing rows as the single member's, when the register holds exactly one", async () => {
    await pool.query("INSERT INTO users (id, display_name) VALUES ($1, 'Fixture Owner')", [FIXTURE_OWNER]);
    await pool.query("INSERT INTO dream_observations (text, kind) VALUES ('a thing seen', 'identity')");
    await pool.query(
      "INSERT INTO dream_preferences (text, kind, origin) VALUES ('a preference', 'preference', 'agent')",
    );

    const result = await labelExistingDreamRows(pool);
    expect(result).toMatchObject({ owner: FIXTURE_OWNER, skippedBecauseSeveralMembers: false });
    expect(result.labelled).toBeGreaterThan(0);

    const obs = await pool.query("SELECT DISTINCT owner FROM dream_observations");
    expect(obs.rows.map((r) => r.owner)).toEqual([FIXTURE_OWNER]);
    const prefs = await pool.query("SELECT DISTINCT owner FROM dream_preferences");
    expect(prefs.rows.map((r) => r.owner)).toEqual([FIXTURE_OWNER]);
  });

  it("labels NOTHING when a second member exists, and says that is why", async () => {
    await pool.query(
      "INSERT INTO users (id, display_name) VALUES ($1,'Fixture Owner'), ($2,'Fixture Second')",
      [FIXTURE_OWNER, FIXTURE_SECOND],
    );
    await pool.query("INSERT INTO dream_observations (text, kind) VALUES ('a thing seen', 'identity')");

    const result = await labelExistingDreamRows(pool);
    expect(result).toEqual({ labelled: 0, owner: null, skippedBecauseSeveralMembers: true });

    const { rows } = await pool.query("SELECT owner FROM dream_observations");
    expect(rows.every((r) => r.owner === null)).toBe(true);
  });

  it("is safe to run twice — a row already labelled is not relabelled", async () => {
    await pool.query("INSERT INTO users (id, display_name) VALUES ($1, 'Fixture Owner')", [FIXTURE_OWNER]);
    await pool.query("INSERT INTO dream_observations (text, kind) VALUES ('a thing seen', 'identity')");

    const first = await labelExistingDreamRows(pool);
    const second = await labelExistingDreamRows(pool);
    expect(first.labelled).toBeGreaterThan(0);
    expect(second.labelled).toBe(0);
    expect(second.owner).toBe(FIXTURE_OWNER);
  });

  it("says why, rather than nothing, when the register holds nobody at all", async () => {
    await pool.query("INSERT INTO dream_observations (text, kind) VALUES ('a thing seen', 'identity')");
    const result = await labelExistingDreamRows(pool);
    expect(result).toEqual({ labelled: 0, owner: null, skippedBecauseSeveralMembers: true });
  });

  it("does not throw when the register itself is not on this database", async () => {
    await pool.query("ALTER TABLE users RENAME TO users_hidden_for_this_test");
    try {
      const result = await labelExistingDreamRows(pool);
      expect(result).toEqual({ labelled: 0, owner: null, skippedBecauseSeveralMembers: true });
    } finally {
      await pool.query("ALTER TABLE users_hidden_for_this_test RENAME TO users");
    }
  });
});
