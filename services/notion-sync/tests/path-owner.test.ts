// `ownerOfPath` (W5I-s9) — the forgotten-file guard's per-path ownership question,
// against a real Postgres (the identity registry the guard actually reads). The
// regression this file exists to pin: a second member in `users` used to switch the
// guard off for EVERYONE (`resolveInstallationOwner` answered `null` the moment the
// row count left 1); the ladder below answers the question per path instead, so a
// second member never disables the first member's own protection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { recordForgotten, wasPathForgotten } from "@lares/vault-format/forget-ledger";
import { ownerOfPath } from "../lib/path-owner.js";

// services/box/sql/014_identity.sql already gives every test DB a `users` /
// `user_aliases` pair (and seeds one installation's own row) — this file adds the
// two neutral fixture members the slice's tests are written against, on top of that.
// `forget_ledger` is NOT part of `startTestDb`'s migration set (it lives past 019, in
// 076), so it is mirrored here verbatim, the same way
// `packages/agent-kit/tests/forget-ledger.test.ts` mirrors it without taking a
// dependency on services/box.
const FORGET_LEDGER_SQL = `
  CREATE TABLE forget_ledger (
    id           bigserial   PRIMARY KEY,
    owner        text        NOT NULL,
    kind         text        NOT NULL,
    match_hash   text        NOT NULL,
    forgotten_at timestamptz NOT NULL DEFAULT now(),
    reason       text        NOT NULL,
    CONSTRAINT forget_ledger_kind_check CHECK (kind IN ('fact', 'note', 'preference')),
    CONSTRAINT forget_ledger_reason_check CHECK (reason IN ('forget', 'erase-person')),
    CONSTRAINT forget_ledger_match_hash_check CHECK (match_hash ~ '^[0-9a-f]{64}$')
  );
  CREATE UNIQUE INDEX forget_ledger_one_per_thing_idx ON forget_ledger (owner, kind, match_hash);
`;

let tdb: TestDb;
let db: Pool;

beforeAll(async () => {
  tdb = await startTestDb();
  db = tdb.pool;
  await db.query(FORGET_LEDGER_SQL);
  await db.query("INSERT INTO users (id, display_name) VALUES ('fixture-owner', 'Fixture Owner')");
  await db.query(
    "INSERT INTO user_aliases (system, alias, user_id) VALUES ('legacy', 'U_fixture', 'fixture-owner')",
  );
}, 180_000);

afterAll(async () => {
  await tdb?.stop();
});

describe("ownerOfPath — the forgotten-file guard's per-path owner", () => {
  it("uses the note's own owner: frontmatter first, resolved through the register", async () => {
    const r = await ownerOfPath(db, "notes/x.md", "---\nscope: private\nowner: U_fixture\n---\n");
    expect(r).toEqual({ owner: "fixture-owner", how: "frontmatter-owner" }); // an alias resolves
  });

  it("uses a per-member area when one exists (ADR-0017 rule 1, after track 5C)", async () => {
    const r = await ownerOfPath(db, "private/fixture-owner/x.md", "");
    expect(r).toEqual({ owner: "fixture-owner", how: "member-area" });
  });

  it("falls back to the sole member — and ONLY when there is exactly one", async () => {
    await db.query("DELETE FROM users WHERE id <> 'fixture-owner'");
    expect(await ownerOfPath(db, "notes/x.md", "---\nscope: private\n---\n"))
      .toEqual({ owner: "fixture-owner", how: "sole-member" });
    await db.query("INSERT INTO users (id, display_name) VALUES ('fixture-second','S')");
    expect(await ownerOfPath(db, "notes/x.md", "---\nscope: private\n---\n"))
      .toEqual({ owner: null, why: "several-members-no-marker" });
  });

  it("a shared path with several members fails OPEN — never blocks a sync", async () => {
    await db.query("INSERT INTO users (id, display_name) VALUES ('fixture-second','S') ON CONFLICT DO NOTHING");
    expect(await ownerOfPath(db, "shared/policies/x.md", "---\nscope: org\n---\n"))
      .toEqual({ owner: null, why: "shared-area" });
  });

  it("an unreadable register fails OPEN and never throws", async () => {
    await db.query("DROP TABLE user_aliases");
    await db.query("DROP TABLE users");
    await expect(ownerOfPath(db, "notes/x.md", "---\nowner: U_fixture\n---\n"))
      .resolves.toEqual({ owner: null, why: "register-unreadable" });

    // Restored (as `packages/agent-kit/tests/forget-ledger.test.ts` restores a table
    // it drops for the same reason) so the tests below see a working register again —
    // the slice's own regression case needs `fixture-owner` to still resolve.
    await db.query(`
      CREATE TABLE users (
        id            text        PRIMARY KEY,
        display_name  text        NOT NULL,
        primary_email text,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`
      CREATE TABLE user_aliases (
        system     text        NOT NULL,
        alias      text        NOT NULL,
        user_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (system, alias)
      )
    `);
    await db.query("INSERT INTO users (id, display_name) VALUES ('fixture-owner', 'Fixture Owner')");
    await db.query(
      "INSERT INTO user_aliases (system, alias, user_id) VALUES ('legacy', 'U_fixture', 'fixture-owner')",
    );
  });

  it("THE REGRESSION: a second member no longer switches the guard off for the first", async () => {
    await db.query("INSERT INTO users (id, display_name) VALUES ('fixture-second','S') ON CONFLICT DO NOTHING");
    const r = await ownerOfPath(db, "notes/x.md", "---\nscope: private\nowner: fixture-owner\n---\n");
    expect(r.owner).toBe("fixture-owner"); // today's code returns null here, for everybody
  });

  // Requirement, not merely a nice property: this guard resolves who owns a PATH — it
  // never checks a member's ledger "to be safe" against a path that turned out to
  // belong to someone else. Proven directly against the real ledger both fixture
  // members feed, on the SAME path spelling, so the only thing distinguishing the two
  // lookups below is the owner key.
  it("one member's forget never suppresses another member's file (two fixture members)", async () => {
    await db.query("INSERT INTO users (id, display_name) VALUES ('fixture-second','S') ON CONFLICT DO NOTHING");
    const a = await ownerOfPath(db, "people/shared-name.md", "---\nscope: private\nowner: fixture-owner\n---\n");
    const b = await ownerOfPath(db, "people/shared-name.md", "---\nscope: private\nowner: fixture-second\n---\n");
    expect(a).toEqual({ owner: "fixture-owner", how: "frontmatter-owner" });
    expect(b).toEqual({ owner: "fixture-second", how: "frontmatter-owner" });

    await recordForgotten(db, { owner: "fixture-owner", kind: "note", words: "people/shared-name.md", reason: "forget" });

    expect(await wasPathForgotten(db, { owner: "fixture-owner", path: "people/shared-name.md" })).not.toBeNull();
    expect(await wasPathForgotten(db, { owner: "fixture-second", path: "people/shared-name.md" })).toBeNull();
  });
});
