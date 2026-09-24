// services/box/tests/person-identity.test.ts — W5I-s1.
//
// The point of this file is COMPLETENESS, PROVEN. "The resolver knows every spelling" is a claim
// nobody can check by reading; the walk below checks it against the schema itself: for EVERY
// `member` table in `lib/member-scope.ts`, the resolver's spellings must actually find the
// fixture owner's row in that table, and must never touch the second fixture person's.
//
// THAT WALK IS THE DRIFT GUARD. A member table added to the inventory later fails here the moment
// it lands, because the fixture holds no row of the owner's in it — which is exactly the moment to
// decide how an erase reaches it. A new `idKind` added to the inventory fails too: `spellingsFor`
// is exhaustive and throws on a convention it was not taught.
//
// TWO DEVIATIONS FROM THE SLICE'S LITERAL TEST TEXT, both forced by the real schema:
//  1. the ambiguity test's two `shared` alias rows are REMOVED again in a `finally`. Left behind,
//     they make both fixture people share a spelling and the slice's own last test ("does not
//     confuse the two fixture people") contradicts its fourth.
//  2. the stranger reminder is inserted with the columns `reminders` actually has
//     (sql/001_init.sql: agent, owner, due_at, payload, created_by — there is no `text` column),
//     and is removed again afterwards.
//
// The fixture database also carries the one live installation's own seeded rows (014/028/029).
// Nothing here asserts on them, and nothing here special-cases them by name.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startThreeSpellingsDb,
  FIXTURE_OWNER,
  FIXTURE_SECOND,
  FIXTURE_ROWS,
  type TestDb,
} from "./helpers/three-spellings.js";
import { MEMBER_SCOPE, type IdKind } from "../lib/member-scope.js";
import {
  resolvePerson,
  spellingsFor,
  unresolvableValues,
  PersonNotFound,
  PersonAmbiguous,
  IdentityRegisterMissing,
} from "../lib/person-identity.js";

let db: TestDb;
beforeAll(async () => {
  db = await startThreeSpellingsDb();
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("person-identity — the resolver", () => {
  it("resolves a person from the canonical id, and from any alias in any system", async () => {
    const byId = await resolvePerson(db.pool, FIXTURE_OWNER);
    const bySlack = await resolvePerson(db.pool, "U_FIXTURE_SLACK");
    const byLegacy = await resolvePerson(db.pool, "U_fixture");
    const byEmail = await resolvePerson(db.pool, "owner@fixture.test");
    for (const r of [bySlack, byLegacy, byEmail]) expect(r.id).toBe(byId.id);
    expect(byId.id).toBe(FIXTURE_OWNER);
    expect(byId.aliases.map((a) => a.system)).toEqual(
      expect.arrayContaining(["email", "legacy", "slack"]),
    );
  });

  it("returns the spellings a principal column actually holds, canonical id included", async () => {
    const p = await resolvePerson(db.pool, FIXTURE_OWNER);
    expect(spellingsFor(p, "principal")).toEqual(
      expect.arrayContaining([FIXTURE_OWNER, "U_fixture", "U_FIXTURE", "U_FIXTURE_SLACK"]),
    );
    // the canonical id leads for an owner-key column — convention already writes it there
    expect(spellingsFor(p, "owner-key")[0]).toBe(FIXTURE_OWNER);
    expect(spellingsFor(p, "registry")).toEqual([FIXTURE_OWNER]);
    expect(spellingsFor(p, "actor")[0]).toBe(FIXTURE_OWNER);
    expect(spellingsFor(p, "actor")).toEqual(p.spellings);
  });

  // ── THE COMPLETENESS PROOF ──────────────────────────────────────────────────────────────────
  it("reaches EVERY member table in the inventory, and none of the other person's rows", async () => {
    const owner = await resolvePerson(db.pool, FIXTURE_OWNER);
    const second = await resolvePerson(db.pool, FIXTURE_SECOND);
    const ownerSpellings = new Set(owner.spellings);
    const secondSpellings = new Set(second.spellings);

    const memberTables = MEMBER_SCOPE.filter((t) => t.scope === "member");
    expect(memberTables.length).toBeGreaterThan(0);

    // The inventory and the fixture may not drift: every member table must hold a row of the
    // owner's for the walk below to mean anything. A new member table lands here first.
    const seededForOwner = new Set(
      FIXTURE_ROWS.filter((r) => ownerSpellings.has(r.value)).map((r) => r.table),
    );
    expect(memberTables.filter((t) => !seededForOwner.has(t.table)).map((t) => t.table)).toEqual([]);

    for (const t of memberTables) {
      expect(t.column, `${t.table} has no person column`).toBeTruthy();
      expect(t.idKind, `${t.table} has no idKind`).toBeTruthy();

      const spellings = spellingsFor(owner, t.idKind as IdKind);
      const { rows } = await db.pool.query<{ value: string }>(
        `SELECT DISTINCT t.${t.column} AS value FROM ${t.table} t WHERE t.${t.column} = ANY($1::text[])`,
        [spellings],
      );

      // found: the resolver yields a spelling that actually finds the owner's row
      expect(rows.length, `${t.table}.${t.column} — the owner's row was not found`).toBeGreaterThan(
        0,
      );
      // and only the owner's: never a spelling belonging to the other fixture person
      for (const r of rows) {
        expect(
          secondSpellings.has(r.value),
          `${t.table}.${t.column} matched "${r.value}", which belongs to the other person`,
        ).toBe(false);
      }
    }
  });

  // This test used to pin the opposite fact — that `oauth_tokens` held a frozen legacy spelling
  // a `column = id` match missed entirely. Box 085 (ruling D4) renamed those values onto the
  // register's id, so the Google token rows are now found by the id itself. The same paragraph
  // still matters for the five tables that ARE still frozen on a legacy spelling, so the second
  // half of the test moved to one of them.
  it("finds the Google token rows by the register's id since box 085, and a frozen spelling by alias", async () => {
    const p = await resolvePerson(db.pool, FIXTURE_OWNER);
    const tokens = await db.pool.query("SELECT 1 FROM oauth_tokens WHERE principal = $1", [p.id]);
    expect(tokens.rowCount).toBeGreaterThan(0);
    const cursors = await db.pool.query(
      "SELECT 1 FROM email_watch_cursors WHERE principal = $1",
      [p.id],
    );
    expect(cursors.rowCount).toBeGreaterThan(0);

    const missed = await db.pool.query("SELECT 1 FROM workflow_jobs WHERE principal = $1", [p.id]);
    expect(missed.rowCount).toBe(0); // still true of the tables nothing has renamed
    const found = await db.pool.query("SELECT 1 FROM workflow_jobs WHERE principal = ANY($1)", [
      spellingsFor(p, "principal"),
    ]);
    expect(found.rowCount).toBeGreaterThan(0);
  });

  it("never guesses: an unknown spelling throws, and a spelling two people claim throws", async () => {
    await expect(resolvePerson(db.pool, "nobody-at-all")).rejects.toThrow(PersonNotFound);
    try {
      await db.pool.query(
        "INSERT INTO user_aliases (system, alias, user_id) VALUES ('legacy','shared',$1)",
        [FIXTURE_SECOND],
      );
      await db.pool.query(
        "INSERT INTO user_aliases (system, alias, user_id) VALUES ('slack','shared',$1)",
        [FIXTURE_OWNER],
      );
      await expect(resolvePerson(db.pool, "shared")).rejects.toThrow(PersonAmbiguous);
      await expect(resolvePerson(db.pool, "shared")).rejects.toThrow(/more than one person/);
    } finally {
      await db.pool.query("DELETE FROM user_aliases WHERE alias = 'shared'");
    }
  });

  it("refuses an id convention it was never taught, instead of answering with no spellings", async () => {
    const p = await resolvePerson(db.pool, FIXTURE_OWNER);
    expect(() => spellingsFor(p, "a-new-convention" as IdKind)).toThrow(
      /id convention this resolver does not know/,
    );
  });

  it("treats a missing identity register as an error, never as a person with no spellings", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS no_register");
      await client.query("SET search_path TO no_register");
      await expect(resolvePerson(client, FIXTURE_OWNER)).rejects.toThrow(IdentityRegisterMissing);
      await expect(unresolvableValues(client, "reminders", "owner")).rejects.toThrow(
        IdentityRegisterMissing,
      );
    } finally {
      client.release(true); // destroyed, not returned: its search_path is no longer the default
    }
  });

  it("reports values that resolve to nobody, so an erase can refuse instead of reporting success", async () => {
    expect(await unresolvableValues(db.pool, "reminders", "owner")).toEqual([]);
    try {
      await db.pool.query(
        `INSERT INTO reminders (agent, owner, due_at, payload, created_by)
         VALUES ('fixture-agent', 'a-stranger', now() + interval '1 day', '{}'::jsonb, 'fixture-agent')`,
      );
      expect(await unresolvableValues(db.pool, "reminders", "owner")).toEqual(["a-stranger"]);
      expect(await unresolvableValues(db.pool, "conversation_entries", "person_key")).toEqual([]);
    } finally {
      await db.pool.query("DELETE FROM reminders WHERE owner = 'a-stranger'");
    }
  });

  it("reads only table and column names the inventory names", async () => {
    await expect(unresolvableValues(db.pool, "memory_proposals", "owner")).rejects.toThrow(
      /not a member column in the inventory/,
    );
    await expect(unresolvableValues(db.pool, "reminders", "agent")).rejects.toThrow(
      /not a member column in the inventory/,
    );
  });

  it("does not confuse the two fixture people", async () => {
    const first = await resolvePerson(db.pool, FIXTURE_OWNER);
    const second = await resolvePerson(db.pool, FIXTURE_SECOND);
    expect(first.spellings.some((s) => second.spellings.includes(s))).toBe(false);
  });
});
