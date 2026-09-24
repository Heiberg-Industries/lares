// @lares/agent-kit/forget-ledger (re-exporting @lares/vault-format/forget-ledger), proved against
// a real Postgres (testcontainers, the pattern this package's other DB-backed tests use). The
// `forget_ledger` table below MIRRORS services/box/sql/076_forget_ledger.sql as an inline
// literal, the way schedule-heartbeat.test.ts and google-auth.test.ts mirror a box table without
// this package taking a dependency on services/box — agent-kit already depends on
// @lares/vault-format and pg, so no package.json changes were needed to write this test.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the ledger is matchable, never readable. No test here may
// pass by matching on the words themselves — every lookup goes through a hash, and one test below
// asserts directly that the forgotten words do not appear anywhere in a stored row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  FORGET_REASONS,
  FORGOTTEN_KINDS,
  isMissingLedgerTable,
  recordForgotten,
  removeForgotten,
  wasForgotten,
  wasPathForgotten,
} from "../src/forget-ledger.js";

// services/box/sql/076_forget_ledger.sql, verbatim in shape (id, owner, kind, match_hash,
// forgotten_at, reason; the same CHECK constraints and the same unique index).
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

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  await db.query(FORGET_LEDGER_SQL);
}, 120_000);

afterAll(async () => {
  await db.end();
  await container.stop();
});

beforeEach(async () => {
  await db.query("TRUNCATE forget_ledger");
});

describe("forget_ledger", () => {
  it("names the three kinds and the two reasons", () => {
    expect([...FORGOTTEN_KINDS]).toEqual(["fact", "note", "preference"]);
    expect([...FORGET_REASONS]).toEqual(["forget", "erase-person"]);
  });

  it("recognises the same sentence said differently", async () => {
    await recordForgotten(db, {
      owner: "fixture-owner", kind: "fact",
      words: "He takes the train, Oslo–Tønsberg.", reason: "forget",
    });
    expect(
      await wasForgotten(db, { owner: "fixture-owner", kind: "fact", words: "he takes the train oslo tønsberg" }),
    ).toMatchObject({ reason: "forget" });
  });

  it("does not recognise a different sentence, however similar", async () => {
    expect(await wasForgotten(db, { owner: "fixture-owner", kind: "fact", words: "he takes the bus" })).toBe(null);
  });

  it("is scoped to one owner", async () => {
    await recordForgotten(db, {
      owner: "fixture-owner", kind: "fact",
      words: "He takes the train, Oslo–Tønsberg.", reason: "forget",
    });
    expect(
      await wasForgotten(db, { owner: "someone-else", kind: "fact", words: "He takes the train, Oslo–Tønsberg." }),
    ).toBe(null);
  });

  it("records the same instruction twice as one ledger fact — a no-op, not an error", async () => {
    const a = await recordForgotten(db, {
      owner: "fixture-owner", kind: "fact",
      words: "He takes the train, Oslo–Tønsberg.", reason: "forget",
    });
    const b = await recordForgotten(db, {
      owner: "fixture-owner", kind: "fact",
      words: "he takes the TRAIN oslo–tønsberg", reason: "forget",
    });
    expect(b).toBe(a);
    const { rows } = await db.query("SELECT 1 FROM forget_ledger");
    expect(rows).toHaveLength(1);
  });

  it("finds a forgotten note by its path", async () => {
    await recordForgotten(db, { owner: "fixture-owner", kind: "note", words: "people/ada.md", reason: "forget" });
    expect(await wasPathForgotten(db, { owner: "fixture-owner", path: "people/ada.md" })).not.toBe(null);
    expect(await wasPathForgotten(db, { owner: "fixture-owner", path: "people/other.md" })).toBe(null);
  });

  it("keeps no substring of the forgotten text in any column of the stored row", async () => {
    const words = "He takes the train, Oslo–Tønsberg.";
    const id = await recordForgotten(db, { owner: "fixture-owner", kind: "fact", words, reason: "forget" });
    const { rows } = await db.query(
      `SELECT id::text, owner, kind, match_hash, forgotten_at::text, reason FROM forget_ledger WHERE id = $1`,
      [id],
    );
    const rowText = JSON.stringify(rows[0]).toLowerCase();
    for (const fragment of ["train", "oslo", "tønsberg", "he takes"]) {
      expect(rowText).not.toContain(fragment.toLowerCase());
    }
  });

  it("stores a fixed-length 64-character hex key however long the forgotten text is", async () => {
    const longWords = "he takes the train ".repeat(120); // > 2,000 characters
    expect(longWords.length).toBeGreaterThan(2000);
    const id = await recordForgotten(db, { owner: "fixture-owner", kind: "fact", words: longWords, reason: "forget" });
    const { rows } = await db.query<{ match_hash: string }>("SELECT match_hash FROM forget_ledger WHERE id = $1", [id]);
    expect(rows[0]!.match_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a kind or reason outside the CHECKed enums", async () => {
    await expect(
      db.query(
        `INSERT INTO forget_ledger (owner, kind, match_hash, reason) VALUES ('fixture-owner', 'guess', repeat('a', 64), 'forget')`,
      ),
    ).rejects.toThrow(/forget_ledger_kind_check/);
    await expect(
      db.query(
        `INSERT INTO forget_ledger (owner, kind, match_hash, reason) VALUES ('fixture-owner', 'fact', repeat('a', 64), 'because')`,
      ),
    ).rejects.toThrow(/forget_ledger_reason_check/);
  });

  it("never throws when the table is missing, and isMissingLedgerTable recognises why", async () => {
    await db.query("DROP TABLE forget_ledger");
    await expect(recordForgotten(db, { owner: "fixture-owner", kind: "fact", words: "x", reason: "forget" }))
      .rejects.toSatisfy((err: unknown) => isMissingLedgerTable(err));
    await db.query(FORGET_LEDGER_SQL);
  });
});

describe("removeForgotten", () => {
  it("undoes recordForgotten for the same words — a later wasForgotten no longer finds it", async () => {
    await recordForgotten(db, {
      owner: "fixture-owner", kind: "fact",
      words: "He takes the train, Oslo–Tønsberg.", reason: "forget",
    });
    await removeForgotten(db, { owner: "fixture-owner", kind: "fact", words: "he takes the TRAIN oslo tønsberg" });
    expect(
      await wasForgotten(db, { owner: "fixture-owner", kind: "fact", words: "He takes the train, Oslo–Tønsberg." }),
    ).toBe(null);
    const { rows } = await db.query("SELECT 1 FROM forget_ledger");
    expect(rows).toHaveLength(0);
  });

  it("is a no-op when nothing matches", async () => {
    await expect(
      removeForgotten(db, { owner: "fixture-owner", kind: "fact", words: "nothing was ever forgotten" }),
    ).resolves.toBeUndefined();
  });

  it("only removes the one owner's matching row, never another's", async () => {
    await recordForgotten(db, { owner: "fixture-owner", kind: "fact", words: "He takes the train.", reason: "forget" });
    await recordForgotten(db, { owner: "someone-else", kind: "fact", words: "He takes the train.", reason: "forget" });
    await removeForgotten(db, { owner: "fixture-owner", kind: "fact", words: "He takes the train." });
    expect(await wasForgotten(db, { owner: "fixture-owner", kind: "fact", words: "He takes the train." })).toBe(null);
    expect(await wasForgotten(db, { owner: "someone-else", kind: "fact", words: "He takes the train." })).not.toBe(null);
  });

  it("throws isMissingLedgerTable, never a bare error, when the table is missing", async () => {
    await db.query("DROP TABLE forget_ledger");
    await expect(removeForgotten(db, { owner: "fixture-owner", kind: "fact", words: "x" }))
      .rejects.toSatisfy((err: unknown) => isMissingLedgerTable(err));
    await db.query(FORGET_LEDGER_SQL);
  });
});
