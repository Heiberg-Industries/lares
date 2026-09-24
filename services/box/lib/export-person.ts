// services/box/lib/export-person.ts — W5E-s2: everything this installation holds about one member,
// written out where they can read it — and none of its secrets.
//
// THE READ-ONLY TWIN OF THE ERASE (ADR-0020 rule 7: export and erase work against the same one
// record). Every table the erase would DELETE a row from, this SELECTs the same row from, through
// the same three shared pieces: `eraseHandlingFor` decides what each inventory entry is,
// `matchClause` builds the same `= ANY(<every spelling>)` match, and the walk is driven FROM
// `lib/member-scope.ts` rather than from a list kept here. There is no second table list in this
// file. That is not tidiness — an export and an erase that disagree about where a person lives is
// the same bug twice: rows the export misses are rows the person never learns they had, and rows
// the erase misses are rows they were told were gone.
//
// WHO. `opts.person` is whatever the operator typed, and the first thing that happens is
// `resolvePerson` — which is also the membership check. An unknown name, a name two people claim,
// a missing register and anybody the register does not hold are each a REFUSAL that writes
// nothing (owner ruling D2: a member of this installation, never a third party a note is about).
//
// THE ONE PROPERTY THIS FILE CANNOT GET WRONG: no token, key or other sign-in material leaves in
// an export. An export is a file a person carries around — mailed to themselves, dropped in a
// cloud folder, kept on a laptop — and a refresh token in it is a live key to their mailbox long
// after they have left. So every exported row goes through `withhold`: a column whose NAME looks
// like key material is replaced by the literal "[withheld]" and named in the manifest, and
// `ALWAYS_WITHHELD` adds, by hand and by table, the columns whose names would otherwise slip past
// the pattern. A `bytea` value is written as its size, never its content. The test that matters
// (tests/export-person.test.ts) plants a marker in a token column and then reads every byte this
// routine wrote, anywhere under the output directory.
//
// WHAT IS EXPORTED THAT MIGHT SURPRISE. An `actor` column names whoever CHANGED an administrative
// row (owner ruling D6). The erase keeps those rows and replaces the name; the export writes them
// out, because they are this person's own activity — "you changed this permission, on this day" —
// and an export that hid them would be telling them less about themselves than the installation
// knows.
//
// WHAT IS NOT EXPORTED, AND IS SAID SO. A `clearedWholeOnly` table has no person column at all; it
// is written out only when this person is the installation's one member, and otherwise named.
// Rows whose person column IS NULL belong to nobody this database can name. An `add` proposal
// names no existing row. The path-keyed sync tables are reached by document, not by person. Each
// of those is counted and named in the report rather than quietly missing — a list of limits that
// only appears when something went wrong is a list nobody reads.
//
// NOTHING IS WRITTEN UNTIL EVERY REFUSAL HAS BEEN ASKED, and a failure part-way removes what this
// run wrote and only what it wrote. Half an export is worse than none: it looks complete.
//
// TABLE AND COLUMN NAMES ARE INTERPOLATED INTO SQL, and can be only because every one of them
// comes from `MEMBER_SCOPE` — a constant in this repository — and never from a request, a settings
// row or anything an operator typed. The person is a bound parameter everywhere.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Queryable } from "./db.js";
import { MEMBER_SCOPE, type ScopeClass, type ScopedTable } from "./member-scope.js";
import {
  eraseHandlingFor,
  matchClause,
  HELD_ID_SOURCES,
  REGISTER_TABLES,
  tablesThatMustExist,
} from "./erase-person.js";
import { findPersonFiles, resolvesWithin } from "./erase-person-vault.js";
import {
  resolvePerson,
  spellingsFor,
  IdentityRegisterMissing,
  PersonAmbiguous,
  PersonNotFound,
  type PersonIdentity,
} from "./person-identity.js";

/** One place this export looked, and what it found there. */
export interface ExportedTable {
  table: string;
  scope: ScopeClass;
  rows: number;
  /** The file, relative to `outDir`. `null` when this place held nothing of theirs — the place was
   *  still looked at, which is why the entry exists at all. */
  file: string | null;
  /** Plain words: what these records are. */
  how: string;
}

/** One vault this export read. */
export interface ExportedVault {
  root: string;
  /** The folder inside `vault/` this root's files were copied under. */
  name: string;
  /** Store-relative paths copied into the export. */
  copied: string[];
  /** Notes that also name somebody else: listed, never copied — they are that person's too. */
  leftShared: string[];
}

/** Something this export deliberately left out. `table` is for the repository test that proves
 *  every place in the inventory is accounted for; the report prints `why`. */
export interface NotIncluded {
  table: string;
  why: string;
  rows?: number;
}

/** One file in the export, as the manifest records it. */
export interface ManifestFile {
  name: string;
  rows?: number;
  bytes?: number;
  sha256: string;
}

export interface ExportReport {
  /** The register's id for this person. Nothing else in this report or the manifest identifies
   *  them: not a display name, not an email address, not an old handle. */
  person: string;
  outDir: string;
  /** UTC, `YYYY-MM-DD`. */
  date: string;
  tables: ExportedTable[];
  vaults: ExportedVault[];
  /** `table.column`, for every column replaced by "[withheld]" in a row that was written. */
  withheld: string[];
  notIncluded: NotIncluded[];
  /** Fixed, stated on every report: what an export cannot contain at all. */
  notReached: readonly string[];
  /** Non-empty means nothing was written. */
  refusals: string[];
}

/** What stands in a file where key material would have been. */
export const WITHHELD = "[withheld]";

/**
 * A column whose NAME says it holds key material. Deliberately broad on the words that only ever
 * appear in secrets (`token`, `secret`, `ciphertext`, `password`, `key_hash`, `api_key`) and
 * deliberately narrow on `enc`, which has to be bounded by an underscore: `recurrence`,
 * `consequence`, `confidence` and `evidence_rule` are all real columns in this schema and none of
 * them is a secret. A name this misses is caught by `ALWAYS_WITHHELD` below, by hand.
 */
export const SECRET_COLUMN_PATTERN =
  /token|secret|ciphertext|password|enc(rypted)?_|_enc$|key_hash|api_key/i;

/**
 * Columns withheld by name, whatever the pattern above thinks — read off the `CREATE TABLE`
 * statement that makes them, not guessed from the inventory's prose.
 *
 * `oauth_tokens` (services/box/sql/006_oauth_tokens.sql, relaxed by 010) is
 * `(id, principal, provider, org_id, email_address, refresh_token_enc, scopes, created_at,
 * updated_at)`. `refresh_token_enc` is `base64(IV||ct||tag)` — AES-256-GCM, the key in
 * `TOKEN_ENC_KEY` and never in the database — and it is the one column of the nine that must
 * never leave. The pattern already catches it twice over; it is named here anyway, because the
 * day somebody renames that column to something the pattern does not read is the day an export
 * quietly starts carrying live credentials.
 */
const ALWAYS_WITHHELD: Readonly<Record<string, readonly string[]>> = {
  oauth_tokens: ["refresh_token_enc"],
};

/** Never an output directory: a secrets mount or the system's own configuration. */
const FORBIDDEN_OUT_DIRS = ["/etc", "/run/secrets"];

/**
 * What an export cannot contain, stated on every report including a clean one.
 *
 * This is `ERASE_OUTSTANDING` (lib/erase-person.ts) read for an export. Two of its four lines do
 * not apply here and are deliberately absent: the vault's git history is about what an erase
 * LEAVES BEHIND, not about what an export could carry, and so is an older backup. The two that
 * remain are the two places a person's words genuinely sit outside this routine's reach.
 */
export const EXPORT_NOT_REACHED: readonly string[] = [
  "Anything said in a conversation that is still open. While a conversation is running the words " +
    "also sit in the agent's own working store, which is cleared when the agent no longer needs " +
    "it to run — this export reads the settled record, not that.",
  "The relationship records, which live in a separate database on this server — a different file " +
    "that this routine does not open.",
];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** Whether this column's value must be replaced rather than written. */
function isSecret(table: string, column: string): boolean {
  if ((ALWAYS_WITHHELD[table] ?? []).includes(column)) return true;
  return SECRET_COLUMN_PATTERN.test(column);
}

async function countWhere(q: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await q.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Export one member: every row this database holds about them, every note of theirs in every
 * vault given, a manifest, and a report a person can read.
 *
 * READ-ONLY against the database — nothing but `SELECT`, no transaction, and a test records every
 * statement to keep it that way. A refusal writes nothing at all.
 */
export async function exportPerson(
  db: Queryable,
  opts: {
    /** Whatever the operator typed: the register id, an old handle, an email address. */
    person: string;
    /** Where the export goes. Created 0700; must not already hold anything. */
    outDir: string;
    /** Every vault to read, in the order given. Empty is a real choice, and the report says so. */
    vaults?: readonly string[];
  },
): Promise<ExportReport> {
  const vaults = opts.vaults ?? [];
  const outDir = resolve(opts.outDir);
  const report: ExportReport = {
    person: opts.person,
    outDir,
    date: new Date().toISOString().slice(0, 10),
    tables: [],
    vaults: [],
    withheld: [],
    notIncluded: [],
    notReached: EXPORT_NOT_REACHED,
    refusals: [],
  };

  // ── Step 0: who. The register is the membership list; anybody it does not hold is refused. ──
  let person: PersonIdentity;
  try {
    person = await resolvePerson(db, opts.person);
  } catch (err) {
    if (
      err instanceof PersonNotFound ||
      err instanceof PersonAmbiguous ||
      err instanceof IdentityRegisterMissing
    ) {
      report.refusals.push(messageOf(err));
      return report;
    }
    throw err;
  }
  report.person = person.id;

  // ── Step 1: can the whole walk run? Asked before a single file exists. The path-keyed sync
  //    tables are never opened by an export, so they need not be present. ────────────────────
  const required = tablesThatMustExist(false);
  const { rows: presence } = await db.query<{ name: string; present: boolean }>(
    `SELECT t.name, to_regclass(t.name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS t(name)`,
    [required.map((t) => t.table)],
  );
  const present = new Map(presence.map((r) => [r.name, r.present]));
  for (const entry of required) {
    if (present.get(entry.table) === false) {
      report.refusals.push(
        `This box has no "${entry.table}" table, so there is no way to tell whether it holds ` +
          "anything of this person's. Nothing was written: an export that quietly skips a place " +
          `is worse than no export at all. Apply ${entry.createdBy}, then run this again.`,
      );
    }
  }

  // ── Step 2: is this a place an export may be written? ────────────────────────────────────
  report.refusals.push(...outDirRefusals(outDir, vaults));
  if (report.refusals.length > 0) return report;

  // ── Step 3: write it. Everything created is remembered, so a failure part-way can take back
  //    exactly what this run made and nothing else. ─────────────────────────────────────────
  const created = { files: [] as string[], dirs: [] as string[], outDirCreated: false };
  const manifestFiles: ManifestFile[] = [];
  const withheld = new Set<string>();

  const makeDirs = (abs: string): void => {
    const missing: string[] = [];
    let cur = dirname(abs);
    while (!existsSync(cur)) {
      missing.push(cur);
      cur = dirname(cur);
    }
    for (const dir of missing.reverse()) {
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      created.dirs.push(dir);
    }
  };

  const writeExportFile = (
    relName: string,
    body: string | Buffer,
    meta: { rows?: number; bytes?: number },
  ): void => {
    const abs = join(outDir, relName);
    if (!resolvesWithin(abs, outDir)) {
      throw new Error(`refusing to write ${relName}: it resolves outside ${outDir}`);
    }
    makeDirs(abs);
    writeFileSync(abs, body, { mode: 0o600 });
    chmodSync(abs, 0o600);
    created.files.push(abs);
    manifestFiles.push({
      name: relName,
      ...meta,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  };

  const writeRows = (
    entry: { table: string; scope: ScopeClass },
    rows: Array<Record<string, unknown>>,
    how: string,
  ): void => {
    if (rows.length === 0) {
      report.tables.push({ table: entry.table, scope: entry.scope, rows: 0, file: null, how });
      return;
    }
    const shaped = rows.map((row) => withhold(entry.table, row, withheld));
    const relName = `data/${entry.table}.json`;
    writeExportFile(relName, JSON.stringify(shaped, null, 2) + "\n", { rows: rows.length });
    report.tables.push({
      table: entry.table,
      scope: entry.scope,
      rows: rows.length,
      file: relName,
      how,
    });
  };

  try {
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      created.outDirCreated = true;
    }
    chmodSync(outDir, 0o700);

    const soleMember = (await countWhere(db, "SELECT count(*)::int AS n FROM users")) === 1;

    // ── The register itself, first: who this person is on this installation. ───────────────
    for (const table of REGISTER_TABLES) {
      const entry = MEMBER_SCOPE.find((t) => t.table === table)!;
      const rows = await selectFor(db, entry, person);
      writeRows(entry, rows, "who they are on this installation");
    }

    // ── Every other member table, in inventory order. ──────────────────────────────────────
    for (const entry of MEMBER_SCOPE) {
      if (entry.scope !== "member") continue;
      if ((REGISTER_TABLES as readonly string[]).includes(entry.table)) continue;
      const rows = await selectFor(db, entry, person);
      writeRows(
        entry,
        rows,
        entry.idKind === "actor"
          ? "entries in the installation's own change log that they made"
          : "their own records",
      );
    }

    // ── memory_proposals, reached only through the ids of rows they own. ───────────────────
    {
      const entry = MEMBER_SCOPE.find((t) => t.table === "memory_proposals")!;
      const heldIds: string[] = [];
      for (const table of HELD_ID_SOURCES) {
        const source = MEMBER_SCOPE.find((t) => t.table === table)!;
        const { rows } = await db.query<{ id: string }>(
          `SELECT id::text AS id FROM ${source.table} WHERE ${matchClause(source)}`,
          [spellingsFor(person, source.idKind!)],
        );
        heldIds.push(...rows.map((r) => r.id));
      }
      const { rows } = heldIds.length
        ? await db.query<Record<string, unknown>>(
            "SELECT * FROM memory_proposals WHERE existing_id = ANY($1::text[])",
            [heldIds],
          )
        : { rows: [] as Array<Record<string, unknown>> };
      writeRows(entry, rows, "changes the agent suggested to something they had said");

      const openAdds = await countWhere(
        db,
        "SELECT count(*)::int AS n FROM memory_proposals WHERE action = 'add'",
      );
      if (openAdds > 0) {
        report.notIncluded.push({
          table: "memory_proposals",
          rows: openAdds,
          why:
            `${openAdds} suggestion${openAdds === 1 ? "" : "s"} waiting for an answer, each one ` +
            "something the agent inferred rather than anything anybody said. They record no " +
            "person at all, so there is no way to tell whether they are about this one.",
        });
      }
    }

    // ── The whole-corpus tables: theirs only if they are the one member here. ──────────────
    for (const entry of MEMBER_SCOPE.filter((t) => t.clearedWholeOnly)) {
      if (soleMember) {
        const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM ${entry.table}`);
        writeRows(
          entry,
          rows,
          "the learned writing voice — this person is the only member, so the whole collection is theirs",
        );
        continue;
      }
      const n = await countWhere(db, `SELECT count(*)::int AS n FROM ${entry.table}`);
      report.notIncluded.push({
        table: entry.table,
        rows: n,
        why:
          `The ${n} sample${n === 1 ? "" : "s"} of the learned writing voice. They record whose ` +
          "words they came from nowhere at all, and somebody else is still a member here, so " +
          "there is no way to say which of them are this person's.",
      });
    }

    // ── The path-keyed sync tables: reached by document, never by person. ──────────────────
    const pathKeyed = MEMBER_SCOPE.filter(
      (t) => eraseHandlingFor(t) === "named-as-out-of-reach",
    );
    for (const entry of pathKeyed) {
      report.notIncluded.push({
        table: entry.table,
        why:
          "What the agents put into Notion or the connected knowledge base. Those records are " +
          "matched by the document they belong to, not by a person — the notes themselves are " +
          "in this export, under the vault they came from.",
      });
    }

    // ── Rows that name nobody: counted, never guessed at. ──────────────────────────────────
    report.notIncluded.push(...(await unattributedNotIncluded(db)));

    // ── The vaults. ────────────────────────────────────────────────────────────────────────
    const usedNames = new Set<string>();
    for (const root of vaults) {
      const name = uniqueVaultName(root, usedNames);
      const copied: string[] = [];
      const leftShared: string[] = [];
      for (const hit of findPersonFiles(root, person.spellings)) {
        if (hit.why === "shared") {
          leftShared.push(hit.path);
          continue;
        }
        const source = join(root, hit.path);
        if (!resolvesWithin(source, root)) {
          throw new Error(
            `refusing to export ${hit.path}: it resolves outside the vault at ${root}`,
          );
        }
        const body = readFileSync(source);
        writeExportFile(`vault/${name}/${hit.path}`, body, { bytes: body.length });
        copied.push(hit.path);
      }
      report.vaults.push({ root, name, copied, leftShared });
    }

    report.withheld = [...withheld].sort();

    // ── The manifest, last: it describes everything above it. ──────────────────────────────
    const manifest = {
      person: report.person,
      date: report.date,
      files: manifestFiles,
      withheld: report.withheld,
      notIncluded: report.notIncluded.map((n) => n.why),
    };
    const body = JSON.stringify(manifest, null, 2) + "\n";
    const manifestPath = join(outDir, "manifest.json");
    writeFileSync(manifestPath, body, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    created.files.push(manifestPath);
  } catch (err) {
    takeBack(created, outDir);
    report.tables = [];
    report.vaults = [];
    report.withheld = [];
    report.notIncluded = [];
    report.refusals.push(
      `This export was stopped, and what it had already written was removed: ${messageOf(err)}`,
    );
  }

  return report;
}

/** The rows of one member table that belong to this person — the same rows `erasePerson` would
 *  delete, found by the same match. */
async function selectFor(
  db: Queryable,
  entry: ScopedTable,
  person: PersonIdentity,
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${entry.table} WHERE ${matchClause(entry)}`,
    [spellingsFor(person, entry.idKind!)],
  );
  return rows;
}

/**
 * One row, safe to write: key material replaced, binary written as its size.
 *
 * The replacement is by COLUMN NAME, on every row, whatever the value looks like — a check on the
 * value would have to recognise ciphertext, and ciphertext that is recognisable is a bug of its
 * own. Every column replaced is recorded as `table.column` for the manifest, so that what is
 * missing from the export is stated rather than merely absent.
 */
function withhold(
  table: string,
  row: Record<string, unknown>,
  withheld: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (isSecret(table, column)) {
      withheld.add(`${table}.${column}`);
      out[column] = WITHHELD;
      continue;
    }
    out[column] = Buffer.isBuffer(value) ? `[binary, ${value.length} bytes]` : value;
  }
  return out;
}

/** Rows whose person column IS NULL: nobody's, as far as this database can tell — the same rule
 *  `erasePerson` follows when it refuses to delete them. Actor columns are excluded: a missing
 *  actor is a missing operator label, not a person's own data. */
async function unattributedNotIncluded(db: Queryable): Promise<NotIncluded[]> {
  const out: NotIncluded[] = [];
  for (const entry of MEMBER_SCOPE) {
    if (entry.scope !== "member" || entry.idKind === "actor") continue;
    if ((REGISTER_TABLES as readonly string[]).includes(entry.table)) continue;
    const n = await countWhere(
      db,
      `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.column} IS NULL`,
    );
    if (n > 0) {
      out.push({
        table: entry.table,
        rows: n,
        why:
          `${n} record${n === 1 ? "" : "s"} in "${entry.table}" name nobody at all — written ` +
          "before this installation recorded who each one belonged to. There is no way to tell " +
          "whether they are this person's, so they were left out rather than guessed at.",
      });
    }
  }
  return out;
}

/** The folder a vault's files are copied under, inside `vault/`. Two roots with the same last
 *  path segment would otherwise write into each other. */
function uniqueVaultName(root: string, used: Set<string>): string {
  const base = basename(resolve(root)) || "vault";
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

/** Every reason this is not a place an export may be written. */
function outDirRefusals(outDir: string, vaults: readonly string[]): string[] {
  const refusals: string[] = [];

  for (const forbidden of FORBIDDEN_OUT_DIRS) {
    if (isUnder(outDir, forbidden)) {
      refusals.push(
        `Refusing to write an export into ${outDir}: ${forbidden} holds this server's own ` +
          "configuration and secrets, and an export must not be mixed in with them. Choose a " +
          "directory of your own.",
      );
    }
  }

  for (const root of vaults) {
    if (resolvesWithin(outDir, root)) {
      refusals.push(
        `Refusing to write an export into ${outDir}: that is inside the vault at ${root}, which ` +
          "this export is reading. The export would end up inside the notes it is copying. " +
          "Choose a directory outside every vault.",
      );
    }
  }

  if (existsSync(outDir)) {
    let entries: string[];
    try {
      if (!statSync(outDir).isDirectory()) {
        refusals.push(
          `Refusing to write an export to ${outDir}: something is already there and it is not a ` +
            "directory.",
        );
        return refusals;
      }
      entries = readdirSync(outDir);
    } catch (err) {
      refusals.push(`Refusing to write an export to ${outDir}: it cannot be read (${messageOf(err)}).`);
      return refusals;
    }
    if (entries.length > 0) {
      refusals.push(
        `Refusing to write an export to ${outDir}: it already has something in it. An export is ` +
          "written into an empty place, so that everything in it came from this one run. Choose " +
          "a new directory, or empty this one yourself.",
      );
    }
  }

  return refusals;
}

/** Undo exactly what this run made: the files it wrote, the directories it created, and the
 *  output directory itself only if it did not already exist. */
function takeBack(
  created: { files: string[]; dirs: string[]; outDirCreated: boolean },
  outDir: string,
): void {
  for (const file of [...created.files].reverse()) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* the report already says the export was stopped */
    }
  }
  for (const dir of [...created.dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* as above */
    }
  }
  if (created.outDirCreated) {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* as above */
    }
  }
}

/** How many, pluralised the plain way. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The report, for the person who asked — who is not a developer. No column names, no id
 * conventions, no SQL. It answers four questions in order: what is in the export and where, what
 * was held back and why, what is not in it and why, and what an export cannot contain at all.
 */
export function renderExportReport(r: ExportReport): string {
  const out: string[] = [];
  out.push(`# An export for ${r.person}`);
  out.push("");

  if (r.refusals.length > 0) {
    out.push("**Nothing was written.** This run refused, and nothing was left behind.");
    out.push("");
    for (const refusal of r.refusals) out.push(`- ${refusal}`);
    out.push("");
    out.push("Fix what is named above and run it again.");
    return out.join("\n");
  }

  const written = r.tables.filter((t) => t.file !== null);
  const rowCount = written.reduce((n, t) => n + t.rows, 0);
  const copied = r.vaults.reduce((n, v) => n + v.copied.length, 0);

  out.push(`Everything this installation holds about them is in \`${r.outDir}\`.`);
  out.push("");
  out.push(
    `**${count(rowCount, "record")}** from ${count(written.length, "place")} in the database, ` +
      `written as one file per place in \`data/\`. **${count(copied, "note")}** of theirs were ` +
      "copied from the vaults, under `vault/`. `manifest.json` lists every file with its size " +
      "and a checksum, so a copy can be checked against the original.",
  );
  out.push("");
  out.push(`Taken on ${r.date} (UTC).`);

  out.push("");
  out.push("## What was held back");
  out.push("");
  if (r.withheld.length === 0) {
    out.push("Nothing. This export holds no sign-in details at all.");
  } else {
    out.push(
      "Saved sign-ins to outside services are secrets; they are never written to an export. " +
        "Anywhere one would have appeared, the export says `[withheld]` instead. The record " +
        "around it — which service, which address, when it was set up — is kept, because that is " +
        "the person's own account of what this installation was connected to. " +
        `${count(r.withheld.length, "value")} of that kind ${
          r.withheld.length === 1 ? "was" : "were"
        } held back; \`manifest.json\` names each one.`,
    );
    out.push("");
    out.push(
      "Anything stored as raw binary is written as its size rather than its contents, for the " +
        "same reason.",
    );
  }

  for (const vault of r.vaults) {
    if (vault.leftShared.length === 0) continue;
    out.push("");
    out.push(`## Notes in ${vault.root} that also name other people`);
    out.push("");
    out.push(
      "These are this person's notes AND somebody else's. Copying them would hand out another " +
        "member's record along with this one's, so they were left where they are, for you to " +
        "decide about by hand:",
    );
    out.push("");
    for (const path of vault.leftShared) out.push(`- ${path}`);
  }

  if (r.vaults.length === 0) {
    out.push("");
    out.push("## No vault was looked at");
    out.push("");
    out.push(
      "No vault was given, so no notes were read and none are in this export. Run this again " +
        "with `--vault <path>` for every vault this person might have notes in.",
    );
  }

  if (r.notIncluded.length > 0) {
    out.push("");
    out.push("## What is not in the export");
    out.push("");
    for (const item of r.notIncluded) out.push(`- ${item.why}`);
  }

  out.push("");
  out.push("## What an export cannot reach");
  out.push("");
  for (const line of r.notReached) out.push(`- ${line}`);

  if (written.length > 0) {
    out.push("");
    out.push("## Where the records came from");
    out.push("");
    out.push("| where | what they are | how many | file |");
    out.push("|---|---|---|---|");
    for (const t of written) out.push(`| ${t.table} | ${t.how} | ${t.rows} | ${t.file} |`);
  }

  out.push("");
  return out.join("\n");
}
