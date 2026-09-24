// services/box/tests/owner-key-normalised.test.ts — W5I-s4.
//
// WHAT THIS FILE IS PROVING. `sql/083_owner_key_is_the_register_id.sql` rewrites a person column
// on sixteen tables of the owner's ONE live installation, by hand, over SSH. A wrong UPDATE there
// does not fail loudly — it orphans somebody's reminders, facts and settings behind a spelling
// nothing matches any more, and reports success. So the properties below are not "does the SQL
// run": they are the four promises the migration's header makes, each checked against the real
// schema on a disposable copy (tests/helpers/three-spellings.ts).
//
//   1. every legacy spelling the register can resolve becomes that person's register id;
//   2. a value NOBODY in the register answers to is never rewritten, never deleted, never
//      guessed at — it survives, and the migration's own result set names it, with its count;
//   3. `forget_ledger` is not rewritten at all (its match_hash was derived from the owner string
//      and can never be re-derived — see the migration's header);
//   4. the dry run in the header predicts exactly what the migration then does, and a second run
//      changes nothing.
//
// THE DRY RUN IS READ OUT OF THE MIGRATION FILE ITSELF, not copied here: the owner is told to
// paste that SELECT into psql before applying anything, so a dry run that has drifted away from
// the migration would be worse than none. `dryRunSelect()` below greps it between the file's two
// markers and runs it, which is what stops it rotting.
//
// TWO DEVIATIONS FROM THE SLICE'S LITERAL TEST TEXT, both forced by the real schema:
//  1. the stranger row is inserted with the columns `reminders` actually has (sql/001_init.sql:
//     agent, owner, due_at, payload, created_by — there is no `text` column, and `due_at` is not
//     the second column), the same correction tests/person-identity.test.ts already had to make.
//  2. the slice's last assertion ("the frozen list is empty") is softened to "fifteen of the
//     sixteen have left it": `forget_ledger` stays an owner key on purpose, by the controller's
//     ruling, and W5I-s7 is the slice that takes it off the list. Asserting an empty list here
//     would be asserting a thing the migration deliberately does not do.
//
// The fixture database also carries the one live installation's own seeded rows (014/028/029).
// Nothing here asserts on them, and nothing here special-cases them by name.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startThreeSpellingsDb,
  FIXTURE_OWNER,
  FIXTURE_SECOND,
  type TestDb,
} from "./helpers/three-spellings.js";
import { MEMBER_SCOPE } from "../lib/member-scope.js";
import { unresolvableValues } from "../lib/person-identity.js";

const SQL = join(__dirname, "..", "sql");
const MIGRATION = readFileSync(join(SQL, "083_owner_key_is_the_register_id.sql"), "utf8");

/** The fifteen the migration rewrites, table and column, in the order the file names them. */
const REWRITTEN: ReadonlyArray<readonly [string, string]> = [
  ["reminders", "owner"],
  ["proactivity_settings", "owner"],
  ["initiations", "owner"],
  ["owner_clock_signals", "owner"],
  ["deadlines", "owner"],
  ["deadline_candidates", "owner"],
  ["deadline_settings", "owner"],
  ["markets_settings", "owner"],
  ["brief_settings", "owner"],
  ["conversation_retention", "owner"],
  ["schedule_settings", "owner"],
  ["agent_notes", "owner"],
  ["memory_use", "owner"],
  ["memory_reads", "owner"],
  ["standing_facts", "user_id"],
];
/** The sixteenth: named by the migration, deliberately left alone. */
const KEPT: readonly [string, string] = ["forget_ledger", "owner"];
const ALL = [...REWRITTEN, KEPT];

// The two legacy spellings the fixture registers as aliases of FIXTURE_OWNER, and one value
// nobody in the register has ever answered to.
const LEGACY = "U_fixture";
const LEGACY_CASE = "U_FIXTURE";
const STRANGER = "a-stranger";

interface Finding {
  table_name: string | null;
  column_name: string | null;
  value: string | null;
  row_count: string | null;
  finding: string;
}
interface DryRunRow {
  table_name: string;
  value: string;
  row_count: string;
  what_083_would_do: string;
}

let db: TestDb;
let dryRunBefore: DryRunRow[];
let report: Finding[];
let countsBeforeMigration: Record<string, number>;
let secondPersonBefore: Record<string, number>;

/** The migration's own result set: the last statement is the findings SELECT. */
async function applyMigration(): Promise<Finding[]> {
  const result = await db.pool.query(MIGRATION);
  const results = Array.isArray(result) ? result : [result];
  const findings = results.find((r) =>
    r.fields?.some((f: { name: string }) => f.name === "finding"),
  );
  if (!findings) throw new Error("083 returned no findings result set");
  return findings.rows as Finding[];
}

/** The dry-run SELECT, read out of the migration file between its own two markers. */
function dryRunSelect(): string {
  const body = MIGRATION.split("-- DRY RUN SELECT — BEGIN")[1]?.split("-- DRY RUN SELECT — END")[0];
  if (!body) throw new Error("083 no longer carries a dry-run SELECT between its markers");
  return body
    .split("\n")
    .filter((line) => line.startsWith("--"))
    .map((line) => line.replace(/^--\s?/, ""))
    .join("\n");
}

async function runDryRun(): Promise<DryRunRow[]> {
  const { rows } = await db.pool.query<DryRunRow>(dryRunSelect());
  return rows;
}

/** One number per table: how many rows it holds at all. */
async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table] of ALL) {
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    out[table] = Number(rows[0].n);
  }
  return out;
}

/** How many rows each table holds for the OTHER fixture person. */
async function secondPersonCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, column] of ALL) {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`,
      [FIXTURE_SECOND],
    );
    out[table] = Number(rows[0].n);
  }
  return out;
}

/** Every distinct person value each table holds, with its row count — the whole state this
 *  migration is allowed to touch, in one comparable shape. */
async function personValues(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [table, column] of ALL) {
    const { rows } = await db.pool.query<{ v: string; n: string }>(
      `SELECT ${column} AS v, count(*) AS n FROM ${table} WHERE ${column} IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    );
    out[table] = Object.fromEntries(rows.map((r) => [r.v, Number(r.n)]));
  }
  return out;
}

beforeAll(async () => {
  db = await startThreeSpellingsDb();

  secondPersonBefore = await secondPersonCounts();

  // Plant the situation the live box is in: the owner's rows written under a legacy spelling,
  // alternating the two the register knows so the case-divergent alias is covered too.
  await Promise.all(
    REWRITTEN.map(([table, column], i) =>
      db.pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [
        i % 2 === 0 ? LEGACY : LEGACY_CASE,
        FIXTURE_OWNER,
      ]),
    ),
  );
  await db.pool.query(`UPDATE forget_ledger SET owner = $1 WHERE owner = $2`, [
    LEGACY,
    FIXTURE_OWNER,
  ]);

  // And one value nobody in the register answers to, planted where it is easiest to see.
  await db.pool.query(
    `INSERT INTO reminders (agent, owner, due_at, payload, created_by)
     VALUES ('fixture-agent', $1, now() + interval '1 day', '{}'::jsonb, 'fixture-agent')`,
    [STRANGER],
  );

  countsBeforeMigration = await rowCounts();
  dryRunBefore = await runDryRun();
  report = await applyMigration();
}, 240_000);

afterAll(async () => {
  await db.stop();
});

describe("box 083 — the owner columns hold the register's id", () => {
  it("rewrites a legacy spelling to the register's id, on every owner-key table", async () => {
    for (const [table, column] of REWRITTEN) {
      const { rows } = await db.pool.query<{ v: string }>(
        `SELECT DISTINCT ${column} AS v FROM ${table}`,
      );
      const values = rows.map((r) => r.v);
      expect(values, table).not.toContain(LEGACY);
      expect(values, table).not.toContain(LEGACY_CASE);
      expect(values, table).toContain(FIXTURE_OWNER);
    }
  });

  it("leaves a value it does not recognise ALONE rather than guessing", async () => {
    const { rows } = await db.pool.query(`SELECT 1 FROM reminders WHERE owner = $1`, [STRANGER]);
    expect(rows).toHaveLength(1);
  });

  it("REPORTS what it left alone — the table, the value and how many rows carry it", () => {
    const stranger = report.find((r) => r.table_name === "reminders" && r.value === STRANGER);
    expect(stranger, JSON.stringify(report, null, 2)).toBeDefined();
    expect(stranger!.column_name).toBe("owner");
    expect(Number(stranger!.row_count)).toBe(1);
    expect(stranger!.finding).toMatch(/^LEFT ALONE - nobody in the identity register answers/);
  });

  it("agrees with the resolver about which values resolve to nobody", async () => {
    for (const [table, column] of ALL) {
      if (!MEMBER_SCOPE.some((t) => t.table === table && t.column === column)) continue;
      const unresolvable = [...(await unresolvableValues(db.pool, table, column))].sort();
      const reportedUnknown = report
        .filter((r) => r.table_name === table && /nobody in the identity register/.test(r.finding))
        .map((r) => r.value as string)
        .sort();
      expect(reportedUnknown, table).toEqual(unresolvable);
    }
  });

  it("does not touch the forget ledger's owner — its hash was computed from that string", async () => {
    expect(MIGRATION).not.toMatch(/UPDATE\s+forget_ledger/i);
    expect(MIGRATION).toMatch(/forget_ledger/); // it is named, and the reason is given
    const { rows } = await db.pool.query<{ owner: string }>(
      `SELECT DISTINCT owner FROM forget_ledger`,
    );
    expect(rows.map((r) => r.owner)).toContain(LEGACY);
    const kept = report.find((r) => r.table_name === "forget_ledger" && r.value === LEGACY);
    expect(kept, JSON.stringify(report, null, 2)).toBeDefined();
    expect(kept!.finding).toMatch(/^LEFT ALONE ON PURPOSE/);
  });

  it("touches nobody else's rows — the second fixture person is untouched", async () => {
    expect(await secondPersonCounts()).toEqual(secondPersonBefore);
    for (const [table, column] of ALL) {
      if (secondPersonBefore[table] === 0) continue;
      const { rows } = await db.pool.query<{ v: string }>(
        `SELECT DISTINCT ${column} AS v FROM ${table}`,
      );
      expect(rows.map((r) => r.v), table).toContain(FIXTURE_SECOND);
    }
  });

  it("deletes nothing and inserts nothing — every table has the row count it had", async () => {
    expect(await rowCounts()).toEqual(countsBeforeMigration);
  });

  it("the dry run in the header predicted exactly this, and predicts nothing more afterwards", async () => {
    const wouldChange = dryRunBefore.filter((r) => r.what_083_would_do.startsWith("WOULD BECOME"));
    expect(wouldChange.map((r) => r.table_name).sort()).toEqual(
      REWRITTEN.map(([t]) => t).sort(),
    );
    for (const row of wouldChange) expect(row.what_083_would_do).toBe(`WOULD BECOME ${FIXTURE_OWNER}`);

    const strangerBefore = dryRunBefore.find(
      (r) => r.table_name === "reminders" && r.value === STRANGER,
    );
    expect(strangerBefore?.what_083_would_do).toMatch(/^LEFT ALONE/);

    const after = await runDryRun();
    expect(after.filter((r) => r.what_083_would_do.startsWith("WOULD BECOME"))).toEqual([]);
  });

  it("re-runs without error and without changing anything the second time", async () => {
    const before = await personValues();
    await applyMigration();
    expect(await personValues()).toEqual(before);
  });

  it("refuses an empty owner from here on, without having failed on one that was already there", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id)
         VALUES ('', 'fixture-agent', 'working', 'no owner', 'owner', 'fixture-session-1', 'fixture-turn-3')`,
      ),
    ).rejects.toThrow(/agent_notes_owner_not_empty/);
  });

  it("the inventory now calls fifteen of the sixteen `registry`, and forget_ledger alone remains", () => {
    const stillOwnerKeys = MEMBER_SCOPE.filter((t) => t.idKind === "owner-key").map((t) => t.table);
    expect(stillOwnerKeys).toEqual(["forget_ledger"]);
    for (const [table] of REWRITTEN) {
      expect(MEMBER_SCOPE.find((t) => t.table === table), table).toMatchObject({
        idKind: "registry",
      });
    }
  });
});
