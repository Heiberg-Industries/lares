// The migration runner's ledger: what has been applied, when, and how (ADR-0021 rule 3).
// See sql/062_schema_migrations.sql for the full rationale behind the shape.
//
// ensureLedger executes the DDL below as a template literal, NOT by reading
// sql/062_schema_migrations.sql off disk: the runner must be able to create its own ledger on a
// database where no migration file has ever been applied, and reading its own migration through
// the machinery it is bootstrapping would be circular. The literal and the file are kept
// identical by a drift test in tests/migration-ledger.test.ts.
import { createHash } from "node:crypto";
import type { Queryable } from "./db.js";

export interface AppliedMigration {
  /** "060_conversation_entries.sql" — the primary key. */
  filename: string;
  /** 60 */
  number: number;
  /** sha256 of the file's bytes, hex. */
  checksum: string;
  appliedAt: Date;
  /** How it got there: the runner ran it, or an operator adopted it as already-applied. */
  how: "applied" | "adopted";
  /** Wall-clock milliseconds the statement took. 0 for an adoption. */
  tookMs: number;
}

export const LEDGER_DDL = `
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  number     integer     NOT NULL,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  how        text        NOT NULL,
  took_ms    integer     NOT NULL DEFAULT 0,
  seq        bigserial   NOT NULL,
  CONSTRAINT schema_migrations_how_check CHECK (how IN ('applied', 'adopted'))
);

CREATE INDEX IF NOT EXISTS schema_migrations_seq_idx ON schema_migrations (seq);

COMMIT;
`;

export async function ensureLedger(db: Queryable): Promise<void> {
  await db.query(LEDGER_DDL);
}

export async function listApplied(db: Queryable): Promise<AppliedMigration[]> {
  const { rows } = await db.query<{
    filename: string;
    number: number;
    checksum: string;
    applied_at: Date;
    how: "applied" | "adopted";
    took_ms: number;
  }>(
    `SELECT filename, number, checksum, applied_at, how, took_ms
       FROM schema_migrations
      ORDER BY seq`,
  );
  return rows.map((r) => ({
    filename: r.filename,
    number: r.number,
    checksum: r.checksum,
    appliedAt: r.applied_at,
    how: r.how,
    tookMs: r.took_ms,
  }));
}

export async function recordApplied(db: Queryable, m: Omit<AppliedMigration, "appliedAt">): Promise<void> {
  await db.query(
    `INSERT INTO schema_migrations (filename, number, checksum, how, took_ms)
     VALUES ($1,$2,$3,$4,$5)`,
    [m.filename, m.number, m.checksum, m.how, m.tookMs],
  );
}

/** sha256 hex of the exact bytes on disk. Not normalised: a whitespace change IS a change. */
export function checksumOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
