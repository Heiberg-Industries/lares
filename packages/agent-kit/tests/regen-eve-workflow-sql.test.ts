// `normaliseStatements` is the whole contract of `regen:eve-sql:check` (ORB-153). The check
// runs a Postgres container and is not part of `pnpm test`, but the decision it makes — is this
// difference schema drift, or is it just how the file was wrapped — is pure and belongs here.
//
// The property in one line: layout may differ, SQL may not. Getting that backwards in either
// direction is expensive. Too strict, and the check is red on the day it ships (it WAS: the
// committed files wrap one ALTER TABLE over two lines where pg_dump emits one) and everyone
// learns to skip it, so the one time it goes red for a dropped column nobody looks. Too loose,
// and a schema change rides through unnoticed onto a box that has no auto-migrate, where it
// surfaces at restore time.
import { describe, it, expect } from "vitest";
import { normaliseStatements, describeDifference } from "../bin/regen-eve-workflow-sql.js";

// The exact statement that made the byte comparison useless — the committed
// sql/001-eve-workflow.sql wraps it, pg_dump 16.15 does not.
const WRAPPED = `ALTER TABLE ONLY workflow_drizzle.workflow_migrations
    ALTER COLUMN id SET DEFAULT nextval('workflow_drizzle.workflow_migrations_id_seq'::regclass);
`;
const ONE_LINE = `ALTER TABLE ONLY workflow_drizzle.workflow_migrations ALTER COLUMN id SET DEFAULT nextval('workflow_drizzle.workflow_migrations_id_seq'::regclass);
`;

describe("normaliseStatements — layout may differ", () => {
  it("reads a wrapped statement and its one-line form as the same statement", () => {
    expect(normaliseStatements(WRAPPED)).toEqual(normaliseStatements(ONE_LINE));
    expect(normaliseStatements(WRAPPED)).toHaveLength(1);
  });

  it("ignores indentation, blank lines and trailing whitespace", () => {
    const loose = "CREATE SCHEMA IF NOT EXISTS workflow;   \n\n\n   CREATE SCHEMA IF NOT EXISTS workflow_drizzle;\n";
    const tight = "CREATE SCHEMA IF NOT EXISTS workflow;\nCREATE SCHEMA IF NOT EXISTS workflow_drizzle;\n";
    expect(normaliseStatements(loose)).toEqual(normaliseStatements(tight));
  });

  it("ignores the service's hand-written header, so a whole file and its DDL body agree", () => {
    // eve-saga's and eve-calliope's headers differ by 27 lines of prose and nothing else;
    // that prose is not part of the schema contract.
    const header = [
      "-- eve-calliope: @workflow/world-postgres schema (extracted for manual box deploy)",
      "--",
      "-- APPLY THIS INTO ITS OWN DATABASE: `lares_calliope`, NOT `lares_state`.",
      "--",
    ].join("\n");
    const body = "CREATE SCHEMA IF NOT EXISTS workflow;\n";
    expect(normaliseStatements(`${header}\n${body}`)).toEqual(normaliseStatements(body));
  });

  it("keeps a DO block whole — its internal semicolons are not statement boundaries", () => {
    const doBlock = `DO $$ BEGIN
    CREATE TYPE workflow.wait_status AS ENUM (
        'waiting',
        'completed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
`;
    const statements = normaliseStatements(doBlock);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("EXCEPTION");
    expect(statements[0]).toContain("END $$;");
  });
});

describe("normaliseStatements — SQL may not", () => {
  it("does NOT read a changed column type as the same statement", () => {
    const before = "CREATE TABLE IF NOT EXISTS workflow.workflow_runs (\n    id character varying NOT NULL\n);\n";
    const after = "CREATE TABLE IF NOT EXISTS workflow.workflow_runs (\n    id text NOT NULL\n);\n";
    expect(normaliseStatements(before)).not.toEqual(normaliseStatements(after));
  });

  it("does NOT read a renamed column, a dropped NOT NULL or a changed default as the same", () => {
    const base = "CREATE TABLE IF NOT EXISTS workflow.workflow_waits (\n    wait_id character varying NOT NULL,\n    created_at timestamp without time zone DEFAULT now() NOT NULL\n);\n";
    const renamed = base.replace("wait_id", "waits_id");
    const nullable = base.replace("wait_id character varying NOT NULL", "wait_id character varying");
    const redefaulted = base.replace("DEFAULT now()", "DEFAULT CURRENT_TIMESTAMP");
    for (const changed of [renamed, nullable, redefaulted]) {
      expect(normaliseStatements(base)).not.toEqual(normaliseStatements(changed));
    }
  });

  it("does NOT hide a dropped statement", () => {
    const both = "CREATE SCHEMA IF NOT EXISTS workflow;\n\nCREATE INDEX IF NOT EXISTS workflow_runs_name_index ON workflow.workflow_runs USING btree (name);\n";
    const one = "CREATE SCHEMA IF NOT EXISTS workflow;\n";
    expect(normaliseStatements(both)).toHaveLength(2);
    expect(normaliseStatements(one)).toHaveLength(1);
    expect(normaliseStatements(both)).not.toEqual(normaliseStatements(one));
  });
});

// The failure message is part of the alarm, not decoration. The first version of it
// head-truncated at 160 characters, and since these statements are CREATE TABLEs that agree
// for their first two hundred, it printed two IDENTICAL-LOOKING lines under the words "these
// differ" — an alarm nobody can act on. The window has to land on the divergence.
describe("describeDifference — the message shows where they diverge", () => {
  const LONG_PREFIX =
    "CREATE TABLE IF NOT EXISTS workflow.workflow_runs ( id character varying NOT NULL, output jsonb, deployment_id character varying NOT NULL, status workflow.status NOT NULL, name character varying NOT NULL, ";
  const committed = `${LONG_PREFIX}error_code text, encryption_public_key character varying );`;
  const regenerated = `${LONG_PREFIX}error_code character varying, encryption_public_key character varying );`;

  it("names the changed type instead of truncating before it", () => {
    const message = describeDifference([committed], [regenerated]);
    expect(message).toContain("error_code text");
    expect(message).toContain("error_code character varying");
  });

  it("pairs a modified statement as one change, not an unrelated add and remove", () => {
    const lines = describeDifference([committed], [regenerated])
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.trimStart().startsWith("-")).toBe(true);
    expect(lines[1]!.trimStart().startsWith("+")).toBe(true);
  });

  it("does not invent a pairing between two unrelated statements", () => {
    const message = describeDifference(
      ["CREATE INDEX IF NOT EXISTS workflow_runs_name_index ON workflow.workflow_runs USING btree (name);"],
      ["CREATE SCHEMA IF NOT EXISTS workflow_drizzle;"],
    );
    expect(message).toContain("- CREATE INDEX");
    expect(message).toContain("+ CREATE SCHEMA");
  });
});
