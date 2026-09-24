// services/box/tests/erase-person-db.test.ts — W5B-s6: erase a person from every table that
// names them, or erase nothing.
//
// WHY THIS FILE IS THE PROOF AND NOT THE README. "Everything was erased" is the one claim in this
// system that cannot be checked by reading: the failure mode is a table nobody listed, reported as
// success. So the central test below does not name the tables it checks — it walks
// `lib/member-scope.ts` and the fixture's own seed list, and asserts that AFTER the erase not one
// row anywhere answers to ANY spelling the owner ever had, while every row belonging to the second
// fixture person is untouched. A member table added to the inventory later fails here the moment
// it lands.
//
// The fixture (tests/helpers/three-spellings.ts) applies every services/box/sql file, the
// chief-of-staff standing-facts family and the dream tables' runtime DDL to a disposable
// Postgres, and seeds two fictional people whose rows use all four id conventions. Nothing here
// ever touches a real installation.
//
// ONE THING THE FIXTURE DOES NOT SEED, and why this file seeds it itself: `memory_proposals` has
// no person column at all, so it has no `(table, column, value)` shape to add to the fixture's
// SEED_ROWS. The two rows it needs — a supersede proposal naming a standing fact of the owner's,
// and an `add` proposal that names no existing row at all — are written here, next to the
// assertion about them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startThreeSpellingsDb,
  FIXTURE_OWNER,
  FIXTURE_SECOND,
  FIXTURE_ROWS,
  type TestDb,
} from "./helpers/three-spellings.js";
import { MEMBER_SCOPE } from "../lib/member-scope.js";
import { resolvePerson, spellingsFor } from "../lib/person-identity.js";
import {
  erasePerson,
  renderEraseReport,
  eraseHandlingFor,
  ERASE_OUTSTANDING,
  type EraseReport,
} from "../lib/erase-person.js";

// A fresh container per test: three of these tests drop a table or delete a person, and a shared
// database would make the order of the file matter.
let db: TestDb;
beforeEach(async () => {
  db = await startThreeSpellingsDb();
}, 180_000);
afterEach(async () => {
  await db.stop();
});

/** A supersede proposal that can only be reached through an id resolved before its owning row
 *  goes, and an `add` proposal that names no existing row at all. */
async function seedMemoryProposals(): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id::text AS id FROM standing_facts WHERE user_id = $1",
    [FIXTURE_OWNER],
  );
  expect(rows.length).toBeGreaterThan(0);
  await db.pool.query(
    `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, origin, source)
     VALUES ('supersede', $1, 'Fixture said something', 'Fixture says something else', 'owner', 'dream')`,
    [rows[0]!.id],
  );
  await db.pool.query(
    `INSERT INTO memory_proposals
       (action, existing_id, existing_text, proposed_text, origin, source, ref, kind)
     VALUES ('add', '', '', 'An inference nobody has confirmed', 'agent', 'dream',
             'identity-fixturehash', 'preference')`,
  );
}

describe("erase-person — the database half", () => {
  it("deletes every member row for that person, under every spelling, and nobody else's", async () => {
    const owner = await resolvePerson(db.pool, FIXTURE_OWNER);
    const second = await resolvePerson(db.pool, FIXTURE_SECOND);

    const report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: false });
    expect(report.refusals).toEqual([]);
    expect(report.deleted.length).toBeGreaterThan(0);

    // Every member table in the inventory, walked against the schema itself.
    for (const entry of MEMBER_SCOPE.filter((t) => t.scope === "member")) {
      const spellings = spellingsFor(owner, entry.idKind!);
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.column} = ANY($1::text[])`,
        [spellings],
      );
      if (entry.idKind === "actor") {
        // D6: an audit row is kept; only the name goes.
        expect(rows[0]!.n, `${entry.table} still names the erased person`).toBe(0);
        const still = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.column} = 'erased'`,
        );
        expect(still.rows[0]!.n, `${entry.table} lost the audit row instead of the name`)
          .toBeGreaterThan(0);
      } else {
        expect(rows[0]!.n, `${entry.table} still holds a row of the erased person's`).toBe(0);
      }
    }

    // And the second fixture person is untouched, everywhere the fixture put a row of theirs.
    const secondSpellings = new Set(second.spellings);
    for (const seeded of FIXTURE_ROWS.filter((r) => secondSpellings.has(r.value))) {
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${seeded.table} WHERE ${seeded.column} = $1`,
        [seeded.value],
      );
      expect(rows[0]!.n, `${seeded.table} lost the other person's row`).toBeGreaterThan(0);
    }
  }, 240_000);

  it("reaches memory_proposals through the ids it resolved, before those ids are deleted", async () => {
    await seedMemoryProposals();

    const report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: false });
    expect(report.refusals).toEqual([]);

    const supersedes = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_proposals WHERE action <> 'add'",
    );
    expect(supersedes.rows[0]!.n).toBe(0);

    // The `add` row names no existing row and no person: it is NOT deleted, it is stated.
    const adds = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_proposals WHERE action = 'add'",
    );
    expect(adds.rows[0]!.n).toBe(1);
    expect(report.outstanding.join("\n")).toMatch(/inference the agent suggested/i);
  }, 240_000);

  it("a dry run writes nothing, counts everything, and issues only read-only statements", async () => {
    const statements: string[] = [];
    const realQuery = db.pool.query.bind(db.pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.pool as any).query = (text: any, values?: any) => {
      if (typeof text === "string") statements.push(text);
      return realQuery(text, values);
    };

    let report: EraseReport;
    try {
      report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: true });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.pool as any).query = realQuery;
    }

    expect(report.dryRun).toBe(true);
    expect(report.refusals).toEqual([]);
    expect(report.planned.reduce((n, p) => n + p.rows, 0)).toBeGreaterThan(0);
    expect(report.deleted).toEqual([]);

    const notReadOnly = statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s));
    expect(notReadOnly, "a dry run issued a statement that is not a plain read").toEqual([]);

    const left = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM conversation_entries WHERE person_key = $1",
      [FIXTURE_OWNER],
    );
    expect(left.rows[0]!.n).toBeGreaterThan(0);
  }, 240_000);

  it("refuses entirely rather than erasing part of a person", async () => {
    await db.pool.query("DROP TABLE memory_reads");

    const report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: false });
    expect(report.refusals.join("\n")).toContain("memory_reads");
    expect(report.refusals.join("\n")).toContain("075_memory_reads.sql");
    expect(report.deleted).toEqual([]);

    const left = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM conversation_entries WHERE person_key = $1",
      [FIXTURE_OWNER],
    );
    expect(left.rows[0]!.n).toBeGreaterThan(0);
    const facts = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    expect(facts.rows[0]!.n).toBeGreaterThan(0);
  }, 240_000);

  it("refuses a name nobody answers to, and anyone who is not a member of this installation", async () => {
    const unknown = await erasePerson(db.pool, { person: "nobody-at-all", dryRun: false });
    expect(unknown.refusals.length).toBe(1);
    expect(unknown.refusals[0]).toMatch(/nobody in the identity register/i);
    expect(unknown.deleted).toEqual([]);

    // A third party a note is merely ABOUT is not a member (owner ruling D2).
    await db.pool.query(
      `INSERT INTO standing_facts (fact, category, source_turn, user_id, origin)
       VALUES ('A note about someone else', 'preference', 'fixture-turn-3', 'a-third-party', 'owner')`,
    );
    const stranger = await erasePerson(db.pool, { person: "a-third-party", dryRun: false });
    expect(stranger.refusals.length).toBe(1);
    expect(stranger.deleted).toEqual([]);
    const still = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = 'a-third-party'",
    );
    expect(still.rows[0]!.n).toBe(1);
  }, 240_000);

  it("leaves the voice corpus alone while somebody else is still a member, and says so", async () => {
    await db.pool.query(
      `INSERT INTO voice_exemplar (id, lang, text, vector)
       VALUES ('fixture-exemplar-1', 'en', 'a sentence in the voice we learned', '[]'::jsonb)`,
    );

    const shared = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: false });
    expect(shared.refusals).toEqual([]);
    const kept = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM voice_exemplar");
    expect(kept.rows[0]!.n).toBe(1);
    expect(shared.outstanding.join("\n")).toMatch(/learned writing voice/i);

    // Leave exactly one member. (The fixture's schema files seed one installation row of their
    // own besides the two fixture people; this removes whoever is left without naming anybody.)
    await db.pool.query("DELETE FROM users WHERE id <> $1", [FIXTURE_SECOND]);

    // Now the person being erased is the only one left: the corpus is theirs, and goes.
    const alone = await erasePerson(db.pool, { person: FIXTURE_SECOND, dryRun: false });
    expect(alone.refusals).toEqual([]);
    expect(alone.wasOnlyMember).toBe(true);
    const gone = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM voice_exemplar");
    expect(gone.rows[0]!.n).toBe(0);
    expect(renderEraseReport(alone)).toMatch(/no member/i);
  }, 240_000);

  it("knows what to do with every member and resolved table in the inventory", () => {
    const unhandled = MEMBER_SCOPE.filter(
      (t) => (t.scope === "member" || t.scope === "resolved") && eraseHandlingFor(t) === null,
    ).map((t) => t.table);
    expect(
      unhandled,
      "these inventory tables have neither a general path, nor an entry in erase-person.ts's " +
        "handling map, nor a line in what the report states it did not reach",
    ).toEqual([]);
  });

  it("states what it did not reach, every time, including on a clean run", () => {
    const clean: EraseReport = {
      person: FIXTURE_OWNER,
      dryRun: false,
      planned: [],
      deleted: [],
      outstanding: [...ERASE_OUTSTANDING],
      refusals: [],
    };
    const md = renderEraseReport(clean);
    expect(md).toMatch(/still open/i); // eve's own session rows
    expect(md).toMatch(/git history/i);
    expect(md).toMatch(/separate database/i); // services/network's SQLite
    expect(md).toMatch(/backup/i);
  });

  it("is written for a person to read: no column names, no jargon", async () => {
    const report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: true });
    const md = renderEraseReport(report);
    for (const jargon of ["idKind", "person_key", "user_id", "grantor_user_id", "updated_by", "= ANY"]) {
      expect(md, `the report says "${jargon}" at a person who does not read code`).not.toContain(
        jargon,
      );
    }
  }, 240_000);
});

describe("erase-person — the sync-state pass (W5B-s8)", () => {
  it("clears the sync row for every path the vault pass removed", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/ada.md', 'p1', 'docs', 'two_way')`,
    );
    await db.pool.query("INSERT INTO atlas_notes (note_path) VALUES ('people/ada.md')");

    const report = await erasePerson(db.pool, {
      person: FIXTURE_OWNER,
      dryRun: false,
      paths: ["people/ada.md"],
    });
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM atlas_notes")).rows).toHaveLength(0);
  }, 240_000);

  it("leaves another file's sync row alone", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/other.md', 'p2', 'docs', 'two_way')`,
    );
    await db.pool.query("INSERT INTO atlas_notes (note_path) VALUES ('people/other.md')");

    const report = await erasePerson(db.pool, {
      person: FIXTURE_OWNER,
      dryRun: false,
      paths: ["people/ada.md"],
    });
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT 1 FROM atlas_notes")).rows).toHaveLength(1);
  }, 240_000);

  it("clears the proposals holding that path's proposed body", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_proposals (vault_path, notion_page_id, proposed_body, base_md_hash, notion_hash)
       VALUES ('people/ada.md', 'p1', 'a proposed body', 'hash-a', 'hash-b')`,
    );
    await db.pool.query(
      `INSERT INTO atlas_proposals (note_path, proposed_note, base_body_hash, sources_hash)
       VALUES ('people/ada.md', 'a proposed note', 'hash-a', 'hash-b')`,
    );

    const report = await erasePerson(db.pool, {
      person: FIXTURE_OWNER,
      dryRun: false,
      paths: ["people/ada.md"],
    });
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_proposals")).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM atlas_proposals")).rows).toHaveLength(0);
  }, 240_000);

  it("warns that the sync run watermark now points at a commit this erase moved past", async () => {
    const r = await erasePerson(db.pool, {
      person: FIXTURE_OWNER,
      dryRun: false,
      paths: ["people/ada.md"],
    });
    expect(r.outstanding.join(" ")).toMatch(/notion_sync_run/);
  }, 240_000);

  it("without paths, leaves the sync tables untouched and still names them in outstanding", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/ada.md', 'p1', 'docs', 'two_way')`,
    );
    await db.pool.query("INSERT INTO atlas_notes (note_path) VALUES ('people/ada.md')");

    const report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: false });
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT 1 FROM atlas_notes")).rows).toHaveLength(1);
    expect(report.outstanding.join(" ")).toMatch(/Notion/);
    expect(report.outstanding.join(" ")).not.toMatch(/notion_sync_run/);
  }, 240_000);

  it("renders the sync-state rows in the same report sections as everything else", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/ada.md', 'p1', 'docs', 'two_way')`,
    );
    const report = await erasePerson(db.pool, {
      person: FIXTURE_OWNER,
      dryRun: true,
      paths: ["people/ada.md"],
    });
    const md = renderEraseReport(report);
    expect(md).toContain("notion_sync_docs");
    for (const jargon of ["idKind", "vault_path", "note_path", "= ANY"]) {
      expect(md, `the report says "${jargon}" at a person who does not read code`).not.toContain(
        jargon,
      );
    }
  }, 240_000);
});
