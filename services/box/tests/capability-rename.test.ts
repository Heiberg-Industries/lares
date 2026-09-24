// services/box/tests/capability-rename.test.ts — W5C-s7 (ADR-0017 rule 1).
//
// WHAT THIS FILE IS PROVING. `sql/077_capability_rename.sql` moves every ratchet/approval_events
// row recorded under `brain`, `atlas` or `memory` onto the single `vault` name, by hand, over SSH.
// W5C-s8 CHANGED WHERE THE ROWS LAND. The controller's ruling is that a vault tool's AREA is its
// ratchet `action` — `(agent, "vault", "shared")`, not `(agent, "vault", "")` — so this migration
// re-keys a capability-default row (`action = ''`) onto its old name's area rather than merging
// three of them onto one row. brain → private, atlas → shared, memory → facts, 1:1.
//
// Six promises, each checked against the real schema on a disposable copy
// (tests/helpers/three-spellings.ts, which already applies every services/box/sql file on disk in
// order — including this one — so it must also be a safe no-op on rows this suite never seeds):
//
//   1. EVERY RECORDED LEVEL MOVES, AND KEEPS ITS OWN LANE. A `action = ''` row under
//      brain/atlas/memory reads `vault` with its AREA as the action afterwards; an approval_events
//      row reads `vault` too (no collision rule and no action there — it is an append-only log,
//      unique only on call_id, and 038 gives it no action column).
//   2. NOTHING MERGES. Two of the three recorded for the same agent at `action = ''` are two
//      different lanes now, so BOTH survive: this is the whole reason the ruling exists.
//   3. THE NARROWEST LEVEL WINS A COLLISION — still, for the rows that can still collide: a
//      NON-EMPTY action (brain/write and memory/write are one `vault/write` row), and a `vault`
//      row a newer image already wrote under the same area. Only the narrowest (most restrictive)
//      survives — a rename must never widen what the owner approved — and a tie is broken
//      deterministically so exactly one row survives.
//   4. EVERY OTHER CAPABILITY IS UNTOUCHED, and so is a pre-existing `vault` row at `action = ''`:
//      nothing in the database says which area it was meant for, so it is left alone and REPORTED,
//      never guessed at.
//   5. NOTHING IS SILENT. Every rename, every drop and every left-alone row is a line in the result
//      set this file ends with.
//   6. IT IS SAFE TO RUN TWICE, and the DRY RUN SELECT in the header predicts exactly what running
//      it for real will do.
//
// AND THE ROLLBACK, WHICH IS NOW HALF REAL. Because the three capability-default rows land on
// three distinct areas, that half of the move is reversible — the ROLLBACK block below really does
// put private/shared/facts back to brain/atlas/memory at `action = ''`, and this file proves
// forward → back → forward lands where the first forward run left it. The other half is still
// lossy and still says so: a dropped collision row is gone, a NON-EMPTY action's old capability
// name is gone, and approval_events has no action column to carry the split.
//
// The image probe hand-builds `ratchet` (008) and `approval_events` (038) before applying files
// numbered ≥39 by glob — this slice adds both hand-builds, and the last test here pins that they
// stayed in the probe script.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startThreeSpellingsDb, type TestDb } from "./helpers/three-spellings.js";

const SQL = join(__dirname, "..", "sql");
const MIGRATION = readFileSync(join(SQL, "077_capability_rename.sql"), "utf8");
const PROBE = join(__dirname, "..", "..", "keeper", "tests", "runtime-image.probe.py");

interface Finding {
  table_name: string | null;
  agent: string | null;
  action: string | null;
  capability: string | null;
  level: string | null;
  row_count: string | null;
  finding: string;
}

interface DryRunRow {
  table_name: string;
  agent: string;
  action: string | null;
  capability: string;
  level: string | null;
  what_077_would_do: string;
}

interface RatchetRow {
  agent: string;
  capability: string;
  action: string;
  level: string;
}

let db: TestDb;

/** The migration's own result set: the last statement is the findings SELECT — the same pattern
 *  `oauth-principal-rename.test.ts` uses for box 085. */
async function apply077(): Promise<Finding[]> {
  const result = await db.pool.query(MIGRATION);
  const results = Array.isArray(result) ? result : [result];
  const findings = results.find((r) => r.fields?.some((f: { name: string }) => f.name === "finding"));
  if (!findings) throw new Error("077 returned no findings result set");
  return findings.rows as Finding[];
}

/** A block of SQL read out of the migration file's own header, between two markers — what a human
 *  is told to paste. Reading it from the file is what stops it drifting from the file. */
function headerSql(marker: string): string {
  const body = MIGRATION.split(`-- ${marker} — BEGIN`)[1]?.split(`-- ${marker} — END`)[0];
  if (!body) throw new Error(`077 no longer carries a ${marker} block between its markers`);
  return body
    .split("\n")
    .filter((line) => line.startsWith("--"))
    .map((line) => line.replace(/^--\s?/, ""))
    .join("\n");
}

async function seedRatchet(rows: Array<[string, string, string, string]>): Promise<void> {
  for (const [agent, capability, action, level] of rows) {
    await db.pool.query(
      `INSERT INTO ratchet (agent, capability, action, level, updated_by)
       VALUES ($1, $2, $3, $4, 'fixture-owner')
       ON CONFLICT (agent, capability, action) DO UPDATE SET level = EXCLUDED.level`,
      [agent, capability, action, level],
    );
  }
}

async function ratchetRowsFor(agent: string): Promise<RatchetRow[]> {
  const { rows } = await db.pool.query<RatchetRow>(
    `SELECT agent, capability, action, level FROM ratchet WHERE agent = $1 ORDER BY capability, action`,
    [agent],
  );
  return rows;
}

beforeAll(async () => {
  db = await startThreeSpellingsDb();
}, 240_000);

afterAll(async () => {
  await db.stop();
});

describe("box 077 — brain/atlas/memory collapse onto vault in ratchet and approval_events", () => {
  it("moves every recorded level onto the one name, a capability default onto its area", async () => {
    await seedRatchet([
      ["fixture-077-a", "brain", "", "gated"],
      ["fixture-077-a", "atlas", "write", "autonomous"],
    ]);
    await apply077();
    const rows = await ratchetRowsFor("fixture-077-a");
    expect(rows).toEqual([
      // `action = ''` → the area the old capability name used to mean on its own.
      { agent: "fixture-077-a", capability: "vault", action: "private", level: "gated" },
      // A row that already named an action keeps it: the action was never the capability.
      { agent: "fixture-077-a", capability: "vault", action: "write", level: "autonomous" },
    ]);
  });

  // THE REASON THE RULING EXISTS. Before it, these two rows became one and the owner could no
  // longer set the shared store and the standing facts apart.
  it("an atlas:autonomous + memory:gated box keeps BOTH — nothing merges, nothing is dropped", async () => {
    await seedRatchet([
      ["fixture-077-areas", "atlas", "", "autonomous"],
      ["fixture-077-areas", "memory", "", "gated"],
    ]);
    const report = await apply077();
    expect(await ratchetRowsFor("fixture-077-areas")).toEqual([
      { agent: "fixture-077-areas", capability: "vault", action: "facts", level: "gated" },
      { agent: "fixture-077-areas", capability: "vault", action: "shared", level: "autonomous" },
    ]);
    expect(report.filter((r) => r.agent === "fixture-077-areas" && r.finding.startsWith("dropped"))).toEqual([]);
  });

  it("all three capability defaults land on three lanes at once", async () => {
    await seedRatchet([
      ["fixture-077-three", "brain", "", "never"],
      ["fixture-077-three", "atlas", "", "gated"],
      ["fixture-077-three", "memory", "", "autonomous"],
    ]);
    await apply077();
    expect(await ratchetRowsFor("fixture-077-three")).toEqual([
      { agent: "fixture-077-three", capability: "vault", action: "facts", level: "autonomous" },
      { agent: "fixture-077-three", capability: "vault", action: "private", level: "never" },
      { agent: "fixture-077-three", capability: "vault", action: "shared", level: "gated" },
    ]);
  });

  it("keeps the narrowest level when two rows collide", async () => {
    await seedRatchet([
      ["fixture-077-b", "brain", "write", "autonomous"],
      ["fixture-077-b", "memory", "write", "never"],
    ]);
    await apply077();
    const rows = await ratchetRowsFor("fixture-077-b");
    expect(rows).toEqual([{ agent: "fixture-077-b", capability: "vault", action: "write", level: "never" }]);
  });

  it("copes with a level already recorded under the new name — narrowest still wins, either way round", async () => {
    await seedRatchet([
      ["fixture-077-v1", "vault", "write", "autonomous"],
      ["fixture-077-v1", "brain", "write", "gated"],
      ["fixture-077-v2", "vault", "write", "never"],
      ["fixture-077-v2", "atlas", "write", "autonomous"],
    ]);
    await apply077();
    expect(await ratchetRowsFor("fixture-077-v1")).toEqual([
      { agent: "fixture-077-v1", capability: "vault", action: "write", level: "gated" },
    ]);
    expect(await ratchetRowsFor("fixture-077-v2")).toEqual([
      { agent: "fixture-077-v2", capability: "vault", action: "write", level: "never" },
    ]);
  });

  // The other way a `vault` row can already exist: the new image ran first, the owner set the
  // shared lane on the permissions board, and only then was this file applied. The old `atlas`
  // default now targets that same lane, so the two collide and the narrowest still wins.
  it("a vault row already set for an AREA collides with the old capability default, narrowest wins", async () => {
    await seedRatchet([
      ["fixture-077-v3", "vault", "shared", "never"],
      ["fixture-077-v3", "atlas", "", "autonomous"],
    ]);
    await apply077();
    expect(await ratchetRowsFor("fixture-077-v3")).toEqual([
      { agent: "fixture-077-v3", capability: "vault", action: "shared", level: "never" },
    ]);
  });

  it("keeps exactly one row when all three collide at the same level", async () => {
    await seedRatchet([
      ["fixture-077-c", "brain", "read", "gated"],
      ["fixture-077-c", "atlas", "read", "gated"],
      ["fixture-077-c", "memory", "read", "gated"],
    ]);
    await apply077();
    const rows = await ratchetRowsFor("fixture-077-c");
    expect(rows).toEqual([{ agent: "fixture-077-c", capability: "vault", action: "read", level: "gated" }]);
  });

  it("leaves every other capability alone", async () => {
    await seedRatchet([["fixture-077-d", "gmail", "send", "gated"]]);
    await apply077();
    const rows = await ratchetRowsFor("fixture-077-d");
    expect(rows).toEqual([{ agent: "fixture-077-d", capability: "gmail", action: "send", level: "gated" }]);
  });

  it("moves the evidence log's capability too, with no collision rule needed", async () => {
    await db.pool.query(
      `INSERT INTO approval_events (agent, capability, tool, decision) VALUES ('fixture-077-e', 'atlas', 'fixture_tool', 'asked')`,
    );
    await apply077();
    const { rows } = await db.pool.query<{ capability: string }>(
      `SELECT capability FROM approval_events WHERE agent = 'fixture-077-e'`,
    );
    expect(rows).toEqual([{ capability: "vault" }]);
  });

  it("is safe to run twice", async () => {
    await apply077();
    await expect(apply077()).resolves.toBeDefined();
  });

  // A `vault` row at `action = ''` can only come from an image that ran before this file did,
  // and nothing in the database says which of the three areas the owner had in mind when they set
  // it. Guessing would hand one area a level meant for another, so it is left exactly as it is —
  // and said out loud, because a level nobody can read is worse than one nobody set.
  it("leaves a pre-existing vault row at action = '' alone, and says so", async () => {
    await seedRatchet([["fixture-077-stray", "vault", "", "autonomous"]]);
    const report = await apply077();
    expect(await ratchetRowsFor("fixture-077-stray")).toEqual([
      { agent: "fixture-077-stray", capability: "vault", action: "", level: "autonomous" },
    ]);
    const said = report.find((r) => r.agent === "fixture-077-stray");
    expect(said, JSON.stringify(report, null, 2)).toBeDefined();
    expect(said!.finding).toMatch(/cannot tell which area/);
    expect(said!.finding).toMatch(/permissions board/);
  });

  it("reports what it renamed and what it dropped — nothing silent", async () => {
    await seedRatchet([
      ["fixture-077-f", "brain", "send", "autonomous"],
      ["fixture-077-f", "memory", "send", "gated"],
    ]);
    const report = await apply077();
    const dropped = report.find((r) => r.agent === "fixture-077-f");
    expect(dropped, JSON.stringify(report, null, 2)).toBeDefined();
    expect(dropped!.finding).toMatch(/^dropped/);
    expect(dropped!.capability).toBe("brain");
    expect(dropped!.level).toBe("autonomous");
    const renamed = report.find((r) => r.table_name === "ratchet" && r.finding.startsWith("ok, renamed"));
    expect(renamed, JSON.stringify(report, null, 2)).toBeDefined();
  });

  it("the dry run in the header predicts the area each row lands on, and the collision", async () => {
    await seedRatchet([
      ["fixture-077-g", "brain", "", "never"],
      ["fixture-077-g", "atlas", "", "autonomous"],
      ["fixture-077-g", "brain", "read", "autonomous"],
      ["fixture-077-g", "memory", "read", "never"],
    ]);
    const { rows } = await db.pool.query<DryRunRow>(headerSql("DRY RUN SELECT"));
    const mine = rows.filter((r) => r.agent === "fixture-077-g");
    // The two capability defaults land on two different lanes, and the dry run names which.
    expect(mine.find((r) => r.capability === "brain" && r.action === "")!.what_077_would_do)
      .toBe("WOULD BECOME vault/private");
    expect(mine.find((r) => r.capability === "atlas" && r.action === "")!.what_077_would_do)
      .toBe("WOULD BECOME vault/shared");
    // The two `read` rows still collide, and the wider one is named before anything runs.
    expect(mine.find((r) => r.what_077_would_do.startsWith("WOULD BE DROPPED"))).toMatchObject({
      capability: "brain", action: "read", level: "autonomous",
    });

    const predicted = new Map(mine.map((r) => [`${r.capability}/${r.action}`, r.what_077_would_do]));
    await apply077();
    // The real run did exactly what was predicted.
    expect(await ratchetRowsFor("fixture-077-g")).toEqual([
      { agent: "fixture-077-g", capability: "vault", action: "private", level: "never" },
      { agent: "fixture-077-g", capability: "vault", action: "read", level: "never" },
      { agent: "fixture-077-g", capability: "vault", action: "shared", level: "autonomous" },
    ]);
    expect(predicted.get("brain/read")).toMatch(/^WOULD BE DROPPED/);

    const after = await db.pool.query<DryRunRow>(headerSql("DRY RUN SELECT"));
    // Afterwards every surviving row is already under the new name, and the dry run says so
    // rather than going quiet — nothing is left that WOULD change.
    expect(after.rows.filter((r) => r.agent === "fixture-077-g").map((r) => r.what_077_would_do).sort()).toEqual([
      "ALREADY vault/private - stays",
      "ALREADY vault/read - stays",
      "ALREADY vault/shared - stays",
    ]);
  });

  // THE HALF THAT BECAME REAL. Three capability defaults land on three distinct areas, so that
  // move — and only that move — can be undone exactly.
  it("the rollback really puts the three areas back, and forward → back → forward lands in one place", async () => {
    await seedRatchet([
      ["fixture-077-h", "brain", "", "gated"],
      ["fixture-077-h", "atlas", "", "never"],
      ["fixture-077-h", "memory", "", "autonomous"],
    ]);
    await apply077();
    const forward = await ratchetRowsFor("fixture-077-h");
    expect(forward).toEqual([
      { agent: "fixture-077-h", capability: "vault", action: "facts", level: "autonomous" },
      { agent: "fixture-077-h", capability: "vault", action: "private", level: "gated" },
      { agent: "fixture-077-h", capability: "vault", action: "shared", level: "never" },
    ]);

    await db.pool.query(headerSql("ROLLBACK"));
    expect(await ratchetRowsFor("fixture-077-h")).toEqual([
      { agent: "fixture-077-h", capability: "atlas", action: "", level: "never" },
      { agent: "fixture-077-h", capability: "brain", action: "", level: "gated" },
      { agent: "fixture-077-h", capability: "memory", action: "", level: "autonomous" },
    ]);

    await apply077();
    expect(await ratchetRowsFor("fixture-077-h")).toEqual(forward);
  });

  it("the image probe hand-builds both tables 077 touches", () => {
    const probe = readFileSync(PROBE, "utf8");
    expect(probe).toMatch(/approval_events/);
    expect(probe).toMatch(/008_ratchet\.sql/);
  });
});
