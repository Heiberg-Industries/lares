#!/usr/bin/env tsx
/**
 * Regenerate an eve service's `sql/001-eve-workflow.sql` from the INSTALLED
 * `@workflow/world-postgres` package (ORB-153).
 *
 * Why this exists: the box has no auto-migrate. `createWorld().start()` does NOT run the
 * package's DDL — only its `bootstrap` CLI does, and nobody runs that against the box. So
 * each eve service carries a hand-applied copy of the package's final schema, and that copy
 * has to be re-derived whenever `@workflow/world-postgres` bumps. Schema drift is the kind
 * that is discovered at RESTORE time, which is the worst time to discover anything.
 *
 * WHAT THE SOURCE ACTUALLY IS. The package ships its own migrations — it lists
 * `src/drizzle/migrations` in package.json `files`, and its `setupDatabase()` (dist/cli.js)
 * runs exactly that folder through drizzle's migrator with
 * `{ migrationsTable: 'workflow_migrations', migrationsSchema: 'workflow_drizzle' }`.
 * This script replays those same migrations, in the journal's own order, into a disposable
 * Postgres, then `pg_dump --schema-only`s the result. That is the same route the committed
 * file's header records for its 2026-08-11 extraction — reproduced mechanically instead of
 * by hand.
 *
 * The migrations are INCREMENTAL (0002 is a bare `ALTER TABLE ... ADD COLUMN`), so
 * concatenating them would not give you the final schema, and would not be re-runnable.
 * Replaying into a real server and dumping is the only derivation that yields both.
 *
 * WHY A CONTAINER AND NOT YOUR LOCAL psql: pg_dump's output dialect is a function of the
 * SERVER version. The box runs Postgres 16 (`pgvector/pgvector:pg16`, services/box/
 * compose.yaml), so this runs pg_dump *inside* a Postgres 16 container. A local pg_dump 15
 * or 17 would produce a byte-different dump and this script's --check would report drift
 * that is really just your Homebrew version.
 *
 * IDEMPOTENCY. pg_dump emits `CREATE TABLE`, not `CREATE TABLE IF NOT EXISTS`. The committed
 * files are re-runnable by hand, so every statement is rewritten to be safe to re-apply —
 * `IF NOT EXISTS` where Postgres offers it, and a DO block for the two forms where it does
 * not (CREATE TYPE, ADD CONSTRAINT). That rewrite is `toIdempotent()` below.
 *
 * WHAT IS PRESERVED. Everything above the first `CREATE SCHEMA` in the committed file is the
 * service's hand-written provenance/deployment header — eve-calliope's carries the
 * "its own workflow database, always" rule that exists because two eve apps once shared one
 * and Saga answered a conversation meant for Marcel. This script never touches that header;
 * it regenerates only the DDL body beneath it.
 *
 * WHAT `--check` COMPARES: statements, not bytes. See `normaliseStatements` — the committed
 * files and pg_dump wrap the same SQL differently, and a check that fails on that is red from
 * the day it ships and therefore ignored by the time it matters. It fails only when a
 * statement's text actually differs: a renamed column, a widened type, a dropped index.
 *
 * Usage:
 *   pnpm regen:eve-sql              # rewrite sql/001-eve-workflow.sql's DDL body
 *   pnpm regen:eve-sql:check        # exit 1 only on a real schema difference
 *
 * Requires Docker. Deliberately NOT part of `pnpm test` — it is a hand-run instrument, in
 * the repo so the next person does not have to rediscover the derivation (CLAUDE.md, "commit
 * the sweep, not just its output").
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const SQL_RELATIVE_PATH = "sql/001-eve-workflow.sql";
/** Matches the box's server major (services/box/compose.yaml: pgvector/pgvector:pg16). */
const DEFAULT_IMAGE = "postgres:16";
/** The two schemas the package owns. Both are string literals inside it — see the file header. */
const SCHEMAS = ["workflow", "workflow_drizzle"] as const;

interface Args {
  service: string;
  check: boolean;
  print: boolean;
  image: string;
}

function parseArgs(argv: string[]): Args {
  let service: string | undefined;
  let check = false;
  let print = false;
  let image = DEFAULT_IMAGE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--print") print = true;
    else if (arg === "--service") service = argv[(i += 1)];
    else if (arg === "--image") image = argv[(i += 1)] ?? DEFAULT_IMAGE;
    else usage(`unknown argument: ${arg}`);
  }
  if (service === undefined) usage("--service <dir> is required");
  return { service: resolve(service), check, print, image };
}

function usage(reason: string): never {
  process.stderr.write(
    `regen-eve-workflow-sql: ${reason}\n\n` +
      `Usage: tsx regen-eve-workflow-sql.ts --service <service dir> [--check|--print] [--image postgres:16]\n\n` +
      `  --check   exit 1 if the committed DDL body has drifted from the installed package\n` +
      `  --print   write the regenerated DDL body to stdout, touching no file\n`,
  );
  process.exit(2);
}

/** The package's own migrations, in the order its journal declares. */
function readMigrations(serviceDir: string): { version: string; files: { tag: string; sql: string }[] } {
  const require_ = createRequire(join(serviceDir, "package.json"));
  let entry: string;
  try {
    // The package's `exports` map does not expose ./package.json, so resolve its main entry
    // and walk up to the package root from there.
    entry = require_.resolve("@workflow/world-postgres");
  } catch {
    throw new Error(
      `@workflow/world-postgres is not resolvable from ${serviceDir}. Run pnpm install first.`,
    );
  }
  let pkgRoot = dirname(entry);
  while (!existsSync(join(pkgRoot, "package.json"))) {
    const parent = dirname(pkgRoot);
    if (parent === pkgRoot) throw new Error(`no package.json above ${entry}`);
    pkgRoot = parent;
  }
  const version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version as string;
  // dist/cli.js resolves this as join(__dirname, '..', 'src', 'drizzle', 'migrations').
  const migrationsDir = join(pkgRoot, "src", "drizzle", "migrations");
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(
      `@workflow/world-postgres@${version} ships no migration journal at ${journalPath}. ` +
        `The package's layout changed; this script's assumption about where migrations live ` +
        `no longer holds and the committed SQL cannot be derived. Do NOT guess a new source.`,
    );
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const files = [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => ({
      tag: entry.tag,
      sql: readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"),
    }));
  return { version, files };
}

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Everything here talks to the server over TCP (`-h 127.0.0.1`), never the unix socket, and
 * that is load-bearing rather than stylistic. The official postgres image runs initdb against
 * a TEMPORARY server started with `listen_addresses=''` — socket only — then shuts it down and
 * starts the real one. `pg_isready` on the socket goes green against that temporary server, so
 * a socket-based readiness check races: it passes, the server restarts underneath you, and the
 * first psql dies with "No such file or directory". Over TCP the temporary server is invisible,
 * so a green check means the real server.
 */
function startPostgres(image: string): string {
  const name = `regen-eve-workflow-sql-${randomBytes(4).toString("hex")}`;
  docker(["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=regen", "-e", "POSTGRES_DB=regen", image]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "regen"]);
      return name;
    } catch {
      execFileSync("sh", ["-c", "sleep 1"]);
    }
  }
  throw new Error(`Postgres container ${name} never became ready`);
}

function psql(container: string, sql: string): void {
  docker(
    ["exec", "-i", "-e", "PGPASSWORD=regen", container, "psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "postgres", "-d", "regen", "-q", "-f", "-"],
    sql,
  );
}

/**
 * The bootstrap DDL drizzle's own migrator runs before the first migration
 * (drizzle-orm/pg-core/dialect.cjs → `migrationTableCreate`), reproduced verbatim so the dump
 * carries `workflow_drizzle.workflow_migrations` exactly as a real bootstrap leaves it. Rows
 * are deliberately not inserted — see the committed file's header.
 */
function drizzleBootstrapSql(): string {
  return [
    `CREATE SCHEMA IF NOT EXISTS "workflow_drizzle";`,
    `CREATE TABLE IF NOT EXISTS "workflow_drizzle"."workflow_migrations" (`,
    `\tid SERIAL PRIMARY KEY,`,
    `\thash text NOT NULL,`,
    `\tcreated_at bigint`,
    `);`,
    "",
  ].join("\n");
}

function dumpSchema(container: string): string {
  return docker([
    "exec",
    "-e",
    "PGPASSWORD=regen",
    container,
    "pg_dump",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-d",
    "regen",
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    ...SCHEMAS.flatMap((s) => ["--schema", s]),
  ]);
}

const TYPE_GUARD_NOTE = "-- CREATE TYPE has no IF NOT EXISTS in Postgres; guard with a DO block instead.";
const CONSTRAINT_GUARD_NOTE = [
  "-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres. A duplicate PRIMARY KEY isn't reported as",
  "-- `duplicate_object` (42710) — Postgres raises `invalid_table_definition` (\"multiple primary",
  "-- keys ... are not allowed\") instead — so guard with an explicit pg_constraint existence",
  "-- check rather than an exception handler keyed on the wrong SQLSTATE.",
].join("\n");

/**
 * Preamble lines pg_dump wraps the schema in, none of which belong in a hand-applied file:
 * blank lines, `--` banners, the `SET`/`SELECT pg_catalog.set_config` session setup, and the
 * `\restrict` / `\unrestrict` psql meta-commands newer pg_dumps fence the output with. The
 * backslash pair matters more than it looks: they carry a random nonce, so leaving them in
 * would make every regeneration differ from the last for no reason at all.
 */
function isPreamble(trimmed: string): boolean {
  return (
    trimmed === "" ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("SET ") ||
    trimmed.startsWith("SELECT pg_catalog.set_config")
  );
}

/** Split a pg_dump body into statements, respecting `$$`-quoted blocks. */
function splitStatements(dump: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollar = false;
  for (const line of dump.split("\n")) {
    const trimmed = line.trim();
    if (!inDollar && current === "" && isPreamble(trimmed)) continue;
    current += (current === "" ? "" : "\n") + line;
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && trimmed.endsWith(";")) {
      statements.push(current);
      current = "";
    }
  }
  if (current.trim() !== "") statements.push(current);
  return statements;
}

/** Rewrite one pg_dump statement into a form that is safe to re-run by hand. */
function toIdempotent(statement: string, seen: { type: boolean; constraint: boolean }): string | undefined {
  const s = statement.trimEnd();

  if (/^CREATE SCHEMA /.test(s)) return s.replace(/^CREATE SCHEMA /, "CREATE SCHEMA IF NOT EXISTS ");
  if (/^CREATE TABLE /.test(s)) return s.replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ");
  if (/^CREATE SEQUENCE /.test(s)) return s.replace(/^CREATE SEQUENCE /, "CREATE SEQUENCE IF NOT EXISTS ");
  if (/^CREATE (UNIQUE )?INDEX /.test(s)) {
    return s.replace(/^CREATE (UNIQUE )?INDEX /, (_m, unique: string | undefined) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `);
  }

  if (/^CREATE TYPE /.test(s)) {
    // pg_dump writes the enum body over several lines; reindent it inside the DO block.
    const body = s
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    const guarded = [
      "DO $$ BEGIN",
      body,
      "EXCEPTION",
      "    WHEN duplicate_object THEN NULL;",
      "END $$;",
    ].join("\n");
    const prefixed = seen.type ? guarded : `${TYPE_GUARD_NOTE}\n${guarded}`;
    seen.type = true;
    return prefixed;
  }

  const constraint = /^ALTER TABLE ONLY ([\w.]+)\n\s*ADD CONSTRAINT (\w+) ([\s\S]+);$/.exec(s);
  if (constraint) {
    const [, table, name, rest] = constraint;
    const schema = table.includes(".") ? table.split(".")[0] : "public";
    const guarded = [
      "DO $$ BEGIN",
      "    IF NOT EXISTS (",
      `        SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND connamespace = '${schema}'::regnamespace`,
      "    ) THEN",
      `        ALTER TABLE ONLY ${table}`,
      `            ADD CONSTRAINT ${name} ${rest};`,
      "    END IF;",
      "END $$;",
    ].join("\n");
    const prefixed = seen.constraint ? guarded : `${CONSTRAINT_GUARD_NOTE}\n${guarded}`;
    seen.constraint = true;
    return prefixed;
  }

  // ALTER SEQUENCE ... OWNED BY and ALTER TABLE ... SET DEFAULT nextval(...) are already
  // re-runnable as written.
  return s;
}

function generateBody(dump: string): string {
  const seen = { type: false, constraint: false };
  const statements = splitStatements(dump)
    .map((s) => toIdempotent(s, seen))
    .filter((s): s is string => s !== undefined);
  return `${statements.join("\n\n")}\n`;
}

/** Items present in one side but not the other, counting duplicates. */
export function multisetDiff(left: string[], right: string[]): { onlyLeft: string[]; onlyRight: string[] } {
  const counts = new Map<string, number>();
  for (const line of right) counts.set(line, (counts.get(line) ?? 0) + 1);
  const onlyLeft: string[] = [];
  for (const line of left) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else onlyLeft.push(line);
  }
  const onlyRight = [...counts.entries()].flatMap(([line, n]) => Array<string>(n).fill(line));
  return { onlyLeft, onlyRight };
}

/**
 * THE CONTRACT: the SQL statements a file declares, with layout thrown away.
 *
 * This is what `--check` compares, and comparing anything else was a mistake worth naming.
 * pg_dump emits `ALTER TABLE ONLY x ALTER COLUMN y SET DEFAULT z;` on one line; the committed
 * files wrap it over two. That is a difference in nothing. A check that fails on it is a check
 * that is red on the day it ships, and a check that is red on the day it ships is a check
 * everybody learns to skip — so the one time it goes red for a dropped column, nobody looks.
 *
 * So: statements are split respecting `$$`-quoted blocks (a DO block is ONE statement, its
 * internal semicolons are not boundaries), comments are dropped, and every run of whitespace
 * inside a statement collapses to a single space. What survives is the schema.
 *
 * Because comments are dropped wholesale, the service's own hand-written header block —
 * eve-calliope's "its own workflow database, always" note and the rest — falls out on its own.
 * That is deliberate: prose about the file is not part of the file's contract, so this may be
 * handed either a whole `001-eve-workflow.sql` or just its DDL body and answer the same.
 *
 * What it deliberately does NOT normalise: identifiers, types, defaults, order. Rename a
 * column, widen a type, drop an index, reorder two statements — every one of those changes the
 * result and fails the check, which is the entire point.
 */
export function normaliseStatements(sql: string): string[] {
  return splitStatements(sql)
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

/**
 * One statement, short enough to read in a failure message, WINDOWED ON THE DIFFERENCE.
 *
 * A plain head-truncation is worse than useless here. These statements are `CREATE TABLE`s
 * hundreds of characters long that agree for the first two hundred; printing their first 160
 * characters shows the reader two identical lines under the words "these differ". The window
 * is placed where the two actually diverge.
 */
function abbreviate(statement: string, focus = 0, width = 150): string {
  if (statement.length <= width) return statement;
  const start = Math.max(0, Math.min(focus - Math.floor(width / 3), statement.length - width));
  const end = Math.min(statement.length, start + width);
  return `${start > 0 ? "…" : ""}${statement.slice(start, end)}${end < statement.length ? "…" : ""}`;
}

/** Index of the first character at which two statements disagree. */
function firstDivergence(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Pair each removed statement with the added statement it most likely became, so a MODIFIED
 * statement reads as one change rather than as an unrelated deletion and addition. Pairing is
 * by longest common prefix, and only when that prefix is long enough to mean something — two
 * statements sharing `CREATE TABLE IF NOT EXISTS ` are not evidence of anything.
 */
const PAIRING_PREFIX_MIN = 40;

export function describeDifference(removed: string[], added: string[]): string {
  const unpairedAdded = [...added];
  const lines: string[] = [];
  for (const before of removed) {
    let bestIndex = -1;
    let bestPrefix = PAIRING_PREFIX_MIN;
    unpairedAdded.forEach((after, i) => {
      const prefix = firstDivergence(before, after);
      if (prefix > bestPrefix) {
        bestPrefix = prefix;
        bestIndex = i;
      }
    });
    if (bestIndex === -1) {
      lines.push(`  - ${abbreviate(before)}`);
      continue;
    }
    const after = unpairedAdded.splice(bestIndex, 1)[0]!;
    const at = firstDivergence(before, after);
    lines.push(`  - ${abbreviate(before, at)}`, `  + ${abbreviate(after, at)}`, "");
  }
  for (const after of unpairedAdded) lines.push(`  + ${abbreviate(after)}`);
  return lines.join("\n");
}

/** The committed file splits into a hand-written header and a generated DDL body. */
function splitCommitted(contents: string): { header: string; body: string } {
  const lines = contents.split("\n");
  const first = lines.findIndex((line) => /^CREATE SCHEMA /.test(line));
  if (first === -1) {
    throw new Error("committed SQL has no `CREATE SCHEMA` line — cannot tell header from body");
  }
  return { header: lines.slice(0, first).join("\n"), body: `${lines.slice(first).join("\n").trimEnd()}\n` };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sqlPath = join(args.service, SQL_RELATIVE_PATH);
  if (!existsSync(sqlPath)) usage(`no ${SQL_RELATIVE_PATH} under ${args.service}`);

  const { version, files } = readMigrations(args.service);
  process.stderr.write(
    `regen-eve-workflow-sql: @workflow/world-postgres@${version}, ${files.length} migrations, image ${args.image}\n`,
  );

  let container: string | undefined;
  let dump: string;
  try {
    container = startPostgres(args.image);
    psql(container, drizzleBootstrapSql());
    for (const file of files) psql(container, file.sql);
    dump = dumpSchema(container);
  } finally {
    if (container !== undefined) {
      try {
        docker(["rm", "-f", container]);
      } catch {
        process.stderr.write(`regen-eve-workflow-sql: WARNING — could not remove container ${container}\n`);
      }
    }
  }

  const generated = generateBody(dump);

  if (args.print) {
    process.stdout.write(generated);
    return;
  }

  const committed = splitCommitted(readFileSync(sqlPath, "utf8"));

  if (args.check) {
    const committedStatements = normaliseStatements(committed.body);
    const generatedStatements = normaliseStatements(generated);
    // A multiset difference, not a positional one: one inserted statement shifts every
    // statement after it, and a positional count would report that as total disagreement.
    const { onlyLeft: removed, onlyRight: added } = multisetDiff(committedStatements, generatedStatements);

    if (removed.length === 0 && added.length === 0) {
      // Formatting is reported, never failed on. Someone reading this after a package bump
      // should be able to see that the file was wrapped by hand without wondering whether
      // the check let something through.
      const wrapping = generated === committed.body ? "" : ", wrapped differently to pg_dump in places";
      process.stdout.write(
        `regen-eve-workflow-sql: ${sqlPath} matches @workflow/world-postgres@${version} ` +
          `— ${committedStatements.length} statements identical${wrapping}\n`,
      );
      return;
    }

    process.stderr.write(
      `regen-eve-workflow-sql: SCHEMA DRIFT — ${sqlPath} does not match @workflow/world-postgres@${version}\n` +
        `  committed:   ${committedStatements.length} statements\n` +
        `  regenerated: ${generatedStatements.length} statements\n` +
        `  ${removed.length} only in the committed file, ${added.length} only in the regeneration\n\n` +
        describeDifference(removed, added) +
        `\nThis is a real schema difference, not layout. Read it before regenerating — the box\n` +
        `has no auto-migrate, so an object dropped here is not missed until a restore.\n` +
        `Run without --check to rewrite the DDL body (the hand-written header is preserved).\n`,
    );
    process.exit(1);
  }

  writeFileSync(sqlPath, `${committed.header}\n${generated}`);
  process.stdout.write(`regen-eve-workflow-sql: wrote ${sqlPath} from @workflow/world-postgres@${version}\n`);
}

// Only when run as a CLI. `normaliseStatements` is the contract `--check` rests on, so it is
// imported and tested directly (tests/regen-eve-workflow-sql.test.ts) — and an import must not
// spin up a Postgres container as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
