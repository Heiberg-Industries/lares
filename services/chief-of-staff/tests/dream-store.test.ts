/**
 * W3A-s8 (docs/decisions/0018-learning-and-dreaming.md, docs/specs/2026-09-18-origin-model-
 * design.md) — coverage for `ensureDreamTables`'s `origin` column and the two dream-store write
 * paths (`record`, `addPreference`) that now require an `Origin`.
 *
 * This is the container half the plan's own note calls for: `ensureDreamTables` is a real
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so a fake `MiniPool` that never executes SQL cannot
 * prove it ran. Runs against a REAL disposable Postgres — the house pattern, following
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
 * W4C-s2 added the `ownerRecurrenceCount` block below, which is where the origin column stops
 * being bookkeeping and starts deciding something.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import { ensureDreamTables, makeDreamStore } from "../lib/dream/store.js";
import type { Observation } from "../lib/dream/reflect.js";

describe("origin on dream rows", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  it("ensureDreamTables adds origin to both tables, idempotently", async () => {
    const pool = getPool();
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
      // Required on `Observation` since W4C-s1. What `record` stores is its third argument, not
      // this field — the next case is the one that proves the two can differ.
      origin: "third_party",
    };
    const row = await store.record(obs, "dream-cycle-2026-09-18", "third_party");
    expect(row.origin).toBe("third_party");
  });

  // W4C-s2: `seenSimilar` ("has anybody ever said this?") gave way to `ownerRecurrenceCount`
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

  it("never counts a row stamped 'agent' by the pre-wave-4 backfill", async () => {
    const pool = getPool();
    const store = makeDreamStore(pool, "fixture-owner");
    // A row as it exists on a live box from before the origin column: `ensureDreamTables`'s
    // ALTER stamped every one of them `'agent'`, and they came from logs of unknown provenance.
    // Unknown is not trusted, so no date cutoff is needed — the backfill default IS the marker.
    await pool.query(
      `INSERT INTO dream_observations (text, text_norm, kind, subject, confidence) VALUES ($1, $2, 'fact', 'legacy', 0.9)`,
      ["a belief of unknown provenance", "a belief of unknown provenance"],
    );
    const { rows } = await pool.query(
      `SELECT origin FROM dream_observations WHERE subject = 'legacy'`,
    );
    expect(rows[0].origin).toBe("agent");
    expect(await store.ownerRecurrenceCount("a belief of unknown provenance")).toBe(0);
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
