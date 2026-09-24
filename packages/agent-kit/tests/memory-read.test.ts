/**
 * tests/memory-read.test.ts — W4A-s4, the read model and export behind a future Memory page.
 *
 * Against a REAL disposable Postgres running the REAL migration files (`sql/002` through
 * `sql/005`, read from disk exactly as `services/keeper/tests/runtime-image.probe.py:66-69`
 * applies them, container style copied from `packages/agent-kit/tests/conversation-record.test.ts`)
 * — the house pattern, ORB-45 lesson: a fake Pool that never executes real SQL is the
 * "built+tested+non-functional" defect class this project has already been bitten by.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MEMORY_PAGE_LIMIT,
  listMemory,
  memoryCsv,
  listMemoryUsed,
  previousTurnIn,
  memoryUsedMarkdown,
  type MemoryFact,
} from "../src/memory-read.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "chief-of-staff", "sql");
const MIGRATIONS = ["002-standing-facts.sql", "003-facts-owner.sql", "004-standing-facts-origin.sql", "005-standing-facts-validity.sql"]
  .map((f) => readFileSync(join(sqlDir, f), "utf8"));

const boxSqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "box", "sql");
const MEMORY_READS_MIGRATION = readFileSync(join(boxSqlDir, "075_memory_reads.sql"), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const migration of MIGRATIONS) await pool.query(migration);
  await pool.query(MEMORY_READS_MIGRATION);
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.stop(); });
beforeEach(async () => { await pool.query("TRUNCATE standing_facts"); });

async function seed(f: { fact: string; category: string; owner: string; statedAt?: Date }): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO standing_facts (fact, category, source_turn, user_id, stated_at, origin)
     VALUES ($1, $2, 'test-turn', $3, COALESCE($4, now()), 'owner')
     RETURNING id`,
    [f.fact, f.category, f.owner, f.statedAt ?? null],
  );
  return Number(rows[0]!.id);
}

describe("listMemory", () => {
  it("lists the standing facts newest first, with where each came from", async () => {
    await seed({ fact: "I take the train", category: "travel", owner: "fixture-owner" });
    await seed({ fact: "Ada runs the north site", category: "people", owner: "fixture-owner" });

    const rows = await listMemory(pool, { owner: "fixture-owner" });
    expect(rows.map((r) => r.fact)).toEqual(["Ada runs the north site", "I take the train"]);
    expect(rows[0]!.shelf).toBe("world");
    expect(rows[1]!.shelf).toBe("conduct");
    expect(rows[0]!.origin).toBe("owner");
    expect(rows[0]!.provenance).toMatch(/said by the owner/i);
    expect(rows[0]!.provenance).toContain("remember");
  });

  it("hides retired rows by default and shows them with their replacement on request", async () => {
    const old = await seed({ fact: "old", category: "travel", owner: "fixture-owner" });
    const next = await seed({ fact: "new", category: "travel", owner: "fixture-owner" });
    await pool.query("UPDATE standing_facts SET retired_at = now(), superseded_by = $2 WHERE id = $1", [old, next]);

    expect((await listMemory(pool, { owner: "fixture-owner" })).map((r) => r.fact)).toEqual(["new"]);
    const all = await listMemory(pool, { owner: "fixture-owner", include: "all" });
    expect(all.find((r) => r.fact === "old")!.supersededBy).toBe(next);
  });

  it("never returns another owner's facts", async () => {
    await seed({ fact: "theirs", category: "travel", owner: "other-owner" });
    expect(await listMemory(pool, { owner: "fixture-owner" })).toEqual([]);
  });

  it("still answers on a database where sql/005 was never applied", async () => {
    await pool.query("ALTER TABLE standing_facts DROP COLUMN recorded_at, DROP COLUMN source, DROP COLUMN superseded_by");
    await seed({ fact: "before the migration", category: "travel", owner: "fixture-owner" });
    const [row] = await listMemory(pool, { owner: "fixture-owner" });
    expect(row!.fact).toBe("before the migration");
    expect(row!.recordedAt).toBeNull();
    expect(row!.source).toBeNull();
    expect(row!.provenance).toMatch(/said by the owner/i);
    // sql/005 is gone for the rest of this file's tests once dropped, so put it back.
    for (const migration of MIGRATIONS) await pool.query(migration);
  });

  it("defaults the page limit and honours a smaller one", async () => {
    for (let i = 0; i < 3; i++) await seed({ fact: `fact ${i}`, category: "travel", owner: "fixture-owner" });
    expect(await listMemory(pool, { owner: "fixture-owner", limit: 1 })).toHaveLength(1);
    expect(MEMORY_PAGE_LIMIT).toBeGreaterThan(3);
  });
});

describe("the export", () => {
  const base: MemoryFact = {
    id: 1,
    owner: "fixture-owner",
    fact: "he said the train",
    category: "travel",
    shelf: "conduct",
    origin: "owner",
    provenance: "said by the owner on 2026-09-18, written by remember",
    statedAt: new Date("2026-09-18T09:00:00Z"),
    recordedAt: new Date("2026-09-18T09:00:00Z"),
    retiredAt: null,
    supersededBy: null,
    sourceTurn: "t1",
    source: "remember",
  };

  it("writes a header row and quotes a fact containing a comma or a quote", () => {
    const csv = memoryCsv([
      { ...base, fact: 'he said "the train", always', category: "travel" },
    ]);
    const [header, line] = csv.split("\n");
    expect(header).toBe("id,owner,fact,category,shelf,origin,source,stated_at,recorded_at,retired_at,superseded_by");
    expect(line).toContain('"he said ""the train"", always"');
  });

  it("renders an empty set as a header and nothing else, never an empty string", () => {
    expect(memoryCsv([]).trim().split("\n")).toHaveLength(1);
  });
});

describe("which memories an answer used", () => {
  it("unions the turn's own reads with the session block's", async () => {
    await pool.query(
      `INSERT INTO memory_reads (session_id, turn_id, owner, kind, ref) VALUES
         ('s1', '',   'fixture-owner', 'standing_fact', '11'),
         ('s1', 't2', 'fixture-owner', 'vault_note',    'people/ada.md'),
         ('s1', 't9', 'fixture-owner', 'vault_note',    'other.md')`,
    );
    const used = await listMemoryUsed(pool, { sessionId: "s1", turnId: "t2" });
    expect(used.map((u) => [u.ref, u.via])).toEqual([
      ["people/ada.md", "this-turn"],
      ["11", "session-block"],
    ]);
  });

  it("names the previous turn, and null on the first", async () => {
    expect(await previousTurnIn(pool, { sessionId: "s1", beforeTurnId: "t9" })).toBe("t2");
    expect(await previousTurnIn(pool, { sessionId: "s1", beforeTurnId: "t2" })).toBe(null);
  });

  it("states the limit rather than implying completeness", () => {
    const md = memoryUsedMarkdown([
      { kind: "vault_note", ref: "people/ada.md", via: "this-turn", at: new Date(0) },
    ]);
    expect(md).toContain("people/ada.md");
    expect(md).toMatch(/searching/i);
    expect(md).not.toMatch(/\b(Saga|Marcel|Calliope|bendik|orbis|heiberg)\b/i);
  });

  it("says nothing was recorded rather than nothing was used — and still states the limit", () => {
    expect(memoryUsedMarkdown([])).toMatch(/nothing recorded/i);
    expect(memoryUsedMarkdown([])).toMatch(/searching/i);
  });

  it("speaks to the owner in plain words, never in column values", () => {
    const md = memoryUsedMarkdown([
      { kind: "standing_fact", ref: "11", via: "session-block", at: new Date(0) },
      { kind: "agent_note", ref: "4", via: "session-block", at: new Date(0) },
      { kind: "vault_note", ref: "people/ada.md", via: "this-turn", at: new Date(0) },
    ]);
    expect(md).not.toMatch(/standing_fact|agent_note|vault_note|session-block|this-turn/);
    expect(md).toContain("Something you told me to remember (11)");
    expect(md).toContain("A note I opened (people/ada.md) — opened for that answer");
  });

  it("answers empty/null rather than throwing when memory_reads is missing (075 not applied)", async () => {
    await pool.query("DROP TABLE memory_reads");
    expect(await listMemoryUsed(pool, { sessionId: "s1", turnId: "t2" })).toEqual([]);
    expect(await previousTurnIn(pool, { sessionId: "s1", beforeTurnId: "t9" })).toBeNull();
    await pool.query(MEMORY_READS_MIGRATION);
  });
});

/**
 * The shelf mapping drift alarm — the `services/console/tests/engine-drift.test.ts` technique:
 * a separate package, a separate build, no import, because the kit cannot import a role
 * service. Read as TEXT, so the day `SHELF_OF_CATEGORY` gains or loses a category in
 * `lib/standing-facts.ts` without a matching edit here, this fails instead of the two silently
 * drifting.
 */
describe("the kit's shelf mapping has not drifted from chief-of-staff's SHELF_OF_CATEGORY", () => {
  it("carries every category name the service declares", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "chief-of-staff", "lib", "standing-facts.ts"),
      "utf8",
    );
    const body = /export const SHELF_OF_CATEGORY: Readonly<Record<StandingFactCategory, FactShelf>> = \{([\s\S]*?)\n\};/u.exec(src)?.[1];
    expect(body, "SHELF_OF_CATEGORY literal not found in the service's standing-facts.ts").toBeDefined();
    const names = [...body!.matchAll(/^\s*([a-z]+):\s*"(world|conduct)",?\s*$/gmu)].map((m) => m[1]!);
    expect(names.length, "no category names parsed out of the service's SHELF_OF_CATEGORY").toBeGreaterThan(0);
    expect(names.sort()).toEqual(["people", "places", "preference", "schedule", "travel"]);

    const kitSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "memory-read.ts"), "utf8");
    const kitBody = /const SHELF_OF_CATEGORY: Readonly<Record<string, "world" \| "conduct">> = \{([\s\S]*?)\n\};/u.exec(kitSrc)?.[1];
    expect(kitBody, "SHELF_OF_CATEGORY literal not found in the kit's memory-read.ts").toBeDefined();
    for (const name of names) expect(kitBody).toContain(name);
  });
});
