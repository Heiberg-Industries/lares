/**
 * (docs/decisions/0018-learning-and-dreaming.md, the origin model) — verifies that the offline
 * dream schema migration preserves origin backfill semantics and covers the dream-store write
 * paths (`record`, `addPreference`) that require an `Origin`.
 *
 * It runs against a REAL disposable Postgres because the migration and store both execute SQL —
 * a fake `MiniPool` cannot prove either one works. This follows the house pattern in
 * `tests/standing-facts.test.ts`'s own header comment — via `@lares/agent-kit/db`'s `getPool()`,
 * which structurally satisfies `store.ts`'s `MiniPool` interface.
 *
 * No `services/chief-of-staff/tests/dream-store.test.ts` existed before this slice — the plan
 * says "append to the dream store test", but `ls tests | grep dream` shows no such file, only
 * `dream-cycle.test.ts`, `dream-modules.test.ts`, `dream-promotion-baseline.test.ts` and
 * `dream-schedule.test.ts`. `dream-modules.test.ts` tests `log-reader.ts`'s writer/reader
 * round-trip — unrelated to the store's origin column, and `log-reader.ts` is off-limits for
 * this slice — so it is left untouched and this file is created fresh instead.
 *
 * The `ownerRecurrenceCount` block below is where the origin column stops
 * being bookkeeping and starts deciding something.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import { quiet } from "./helpers/quiet-pool.js";
import { ensureDreamTables, makeDreamStore } from "../lib/dream/store.js";

import type { Observation } from "../lib/dream/reflect.js";

const DREAM_SCHEMA_SQL = readFileSync(new URL("../../box/sql/026_dream_schema.sql", import.meta.url), "utf8");

describe("origin on dream rows", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    await quiet(getPool()).query(DREAM_SCHEMA_SQL);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  it("the offline migration creates the origin columns and readiness checks are read-only", async () => {
    const pool = quiet(getPool());
    await ensureDreamTables(pool);
    await ensureDreamTables(pool);
    for (const t of ["dream_observations", "dream_preferences"]) {
      const { rows } = await pool.query(
        "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name='origin'",
        [t],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_nullable).toBe("NO");
      expect(rows[0].column_default).toContain("'agent'");
    }
  });

  it("record stores the class it was given, not a guess", async () => {
    const pool = getPool();
    const store = makeDreamStore(pool, "fixture-owner");
    // `evidenceRefs` is required on `Observation` (lib/dream/reflect.ts) — the plan's own
    // literal for this test omits it; added here so the test compiles.
    const obs: Observation = {
      text: "prefers the train",
      kind: "preference",
      subject: "",
      confidence: 0.4,
      evidenceRefs: [],
      // Required on `Observation`. What `record` stores is its third argument, not
      // this field — the next case is the one that proves the two can differ.
      origin: "third_party",
    };
    const row = await store.record(obs, "dream-cycle-2026-09-18", "third_party");
    expect(row.origin).toBe("third_party");
  });

  // `seenSimilar` ("has anybody ever said this?") gave way to `ownerRecurrenceCount`
  // ("how many times is the OWNER on record as having said this?"). These two cases are the
  // reason the gate above them is worth anything — they run the real SQL, against a real
  // Postgres, because the whole rule is one WHERE clause.
  it("counts only what the owner said — a third party repeating itself raises nobody's count", async () => {
    const pool = getPool();
    const store = makeDreamStore(pool, "fixture-owner");
    const text = "the company switches to annual prepay";
    const obs: Observation = {
      text, kind: "fact", subject: "billing", confidence: 0.4, evidenceRefs: [], origin: "third_party",
    };

    // The published attack, in three rows: the same claim, three times, from outside.
    await store.record(obs, "dream-cycle-2026-09-19", "third_party");
    await store.record(obs, "dream-cycle-2026-09-19", "third_party");
    await store.record(obs, "dream-cycle-2026-09-19", "third_party");
    expect(await store.ownerRecurrenceCount(text)).toBe(0);

    // A synced document saying it does not help either.
    await store.record(obs, "dream-cycle-2026-09-19", "synced");
    expect(await store.ownerRecurrenceCount(text)).toBe(0);

    // The owner saying it twice is the only thing that counts — and each saying counts once.
    await store.record(obs, "dream-cycle-2026-09-19", "owner");
    expect(await store.ownerRecurrenceCount(text)).toBe(1);
    await store.record(obs, "dream-cycle-2026-09-19", "owner");
    expect(await store.ownerRecurrenceCount(text)).toBe(2);
  });

  it("migration backfills old rows as agent and never infers an owner", async () => {
    const pool = getPool();
    await pool.query("DROP TABLE dream_observations, dream_preferences");
    await pool.query(`
      CREATE TABLE dream_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), text text NOT NULL,
        kind text NOT NULL, subject text NOT NULL DEFAULT '',
        confidence double precision NOT NULL DEFAULT 0, source text,
        valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE dream_preferences (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), text text NOT NULL,
        kind text NOT NULL, subject text NOT NULL DEFAULT '',
        confidence double precision NOT NULL DEFAULT 0, source text,
        valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz,
        superseded_by uuid, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO dream_observations (text, kind, subject) VALUES ('old observation', 'fact', 'legacy');
      INSERT INTO dream_preferences (text, kind, subject) VALUES ('old preference', 'preference', 'legacy');
    `);
    await pool.query(DREAM_SCHEMA_SQL);
    await ensureDreamTables(pool);

    const observations = await pool.query("SELECT origin, owner, text_norm FROM dream_observations WHERE subject='legacy'");
    expect(observations.rows).toEqual([{ origin: "agent", owner: null, text_norm: null }]);
    const preferences = await pool.query("SELECT origin, owner FROM dream_preferences WHERE subject='legacy'");
    expect(preferences.rows).toEqual([{ origin: "agent", owner: null }]);
    expect(await makeDreamStore(pool, "fixture-owner").ownerRecurrenceCount("old observation")).toBe(0);
  });

  it("addPreference requires an origin", async () => {
    const pool = getPool();
    const store = makeDreamStore(pool, "fixture-owner");
    const pref = await store.addPreference({
      text: "x",
      kind: "preference",
      subject: "",
      confidence: 0.4,
      origin: "agent",
    });
    expect(pref.origin).toBe("agent");
  });
});
